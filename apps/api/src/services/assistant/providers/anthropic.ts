import { AssistantProviderError, type AssistantProvider, type CompletionRequest, type CompletionResult } from './provider.js';

/**
 * Anthropic's Messages API, over fetch. No SDK: one POST is all the assistant
 * makes, and a package for it would be a dependency to keep current for no
 * gain.
 *
 * The key travels only in the x-api-key header of this request. It is not
 * logged, and an error carries the status and the provider's error type only.
 *
 * No temperature is sent unless one is configured: Claude 4.7 and later
 * models, Haiku 5.5 included, refuse a request that sets a sampling
 * parameter. Steadiness comes from the strict prompt and the reply checks.
 */

const MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

export interface AnthropicConfig {
  apiKey: string;
  model: string;
  timeoutMs: number;
  temperature?: number;
  /** Injected in tests; the global fetch otherwise. */
  fetchImpl?: typeof fetch;
}

interface MessagesResponse {
  content?: Array<{ type?: string; text?: string }>;
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** The provider's error type, if it is a plain identifier; never its free text. */
function errorType(body: unknown): string | null {
  const type = (body as { error?: { type?: unknown } } | null)?.error?.type;
  return typeof type === 'string' && /^[a-z_]{1,40}$/.test(type) ? type : null;
}

export function createAnthropicProvider(config: AnthropicConfig): AssistantProvider {
  const send = config.fetchImpl ?? fetch;

  return {
    name: 'anthropic',
    model: config.model,
    async complete(request: CompletionRequest): Promise<CompletionResult> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.timeoutMs);
      timer.unref?.();

      let response: Response;
      try {
        response = await send(MESSAGES_URL, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'content-type': 'application/json',
            'x-api-key': config.apiKey,
            'anthropic-version': API_VERSION,
          },
          body: JSON.stringify({
            model: config.model,
            max_tokens: request.maxOutputTokens,
            system: request.system,
            messages: [{ role: 'user', content: request.user }],
            ...(config.temperature === undefined ? {} : { temperature: config.temperature }),
          }),
        });
      } catch (error) {
        const aborted = error instanceof Error && error.name === 'AbortError';
        throw new AssistantProviderError(aborted ? 'The model provider did not answer in time.' : 'The model provider could not be reached.');
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        const type = errorType(await response.json().catch(() => null));
        throw new AssistantProviderError(
          `The model provider answered ${response.status}${type ? ` (${type})` : ''}.`,
          response.status,
        );
      }

      const data = (await response.json().catch(() => null)) as MessagesResponse | null;
      if (!data || !Array.isArray(data.content)) {
        throw new AssistantProviderError('The model provider sent a reply that could not be read.', response.status);
      }

      return {
        text: data.content
          .filter((part) => part.type === 'text' && typeof part.text === 'string')
          .map((part) => part.text)
          .join(''),
        truncated: data.stop_reason === 'max_tokens',
        inputTokens: data.usage?.input_tokens,
        outputTokens: data.usage?.output_tokens,
      };
    },
  };
}
