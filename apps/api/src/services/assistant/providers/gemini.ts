import { AssistantProviderError, type AssistantProvider, type CompletionRequest, type CompletionResult } from './provider.js';

/**
 * Google's Gemini API (generateContent), over fetch, the same way as the
 * Anthropic provider: one POST, no SDK.
 *
 * The key travels only in the x-goog-api-key header, never in the URL, so it
 * cannot end up in a proxy or access log. An error carries the status and
 * Google's short status word only.
 *
 * Thinking is switched off. Flash models think by default, and the thinking
 * tokens count against maxOutputTokens: at the assistant's ceiling of 350,
 * gemini-3.5-flash spent the whole budget thinking and returned half a
 * sentence (finishReason MAX_TOKENS, 15 November 2026). Answers here are a few
 * sentences quoted from the documentation, which needs no reasoning step.
 * Flash-Lite models do not think and refuse the setting, so it is left off
 * for them.
 */

const API_ROOT = 'https://generativelanguage.googleapis.com/v1beta/models';

export interface GeminiConfig {
  apiKey: string;
  model: string;
  timeoutMs: number;
  temperature?: number;
  /** Injected in tests; the global fetch otherwise. */
  fetchImpl?: typeof fetch;
}

interface GenerateContentResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string; thought?: boolean }> };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

/** Google's status word (INVALID_ARGUMENT, UNAVAILABLE…), never its free text. */
function errorStatus(body: unknown): string | null {
  const status = (body as { error?: { status?: unknown } } | null)?.error?.status;
  return typeof status === 'string' && /^[A-Z_]{1,40}$/.test(status) ? status : null;
}

/** Models that take a thinking budget. Lite models do not think and refuse one. */
export function geminiThinks(model: string): boolean {
  return !/-lite\b/i.test(model);
}

export function createGeminiProvider(config: GeminiConfig): AssistantProvider {
  const send = config.fetchImpl ?? fetch;
  // A model name, not a path: letters, digits, dots and dashes only.
  if (!/^[a-z0-9][a-z0-9.-]{0,80}$/i.test(config.model)) {
    throw new AssistantProviderError('ASSISTANT_MODEL is not a Gemini model name.');
  }

  return {
    name: 'gemini',
    model: config.model,
    async complete(request: CompletionRequest): Promise<CompletionResult> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.timeoutMs);
      timer.unref?.();

      let response: Response;
      try {
        response = await send(`${API_ROOT}/${config.model}:generateContent`, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'content-type': 'application/json',
            'x-goog-api-key': config.apiKey,
          },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: request.system }] },
            contents: [{ role: 'user', parts: [{ text: request.user }] }],
            generationConfig: {
              maxOutputTokens: request.maxOutputTokens,
              ...(geminiThinks(config.model) ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
              ...(config.temperature === undefined ? {} : { temperature: config.temperature }),
            },
          }),
        });
      } catch (error) {
        const aborted = error instanceof Error && error.name === 'AbortError';
        throw new AssistantProviderError(aborted ? 'The model provider did not answer in time.' : 'The model provider could not be reached.');
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        const status = errorStatus(await response.json().catch(() => null));
        throw new AssistantProviderError(
          `The model provider answered ${response.status}${status ? ` (${status})` : ''}.`,
          response.status,
        );
      }

      const data = (await response.json().catch(() => null)) as GenerateContentResponse | null;
      const candidate = data?.candidates?.[0];
      if (!data || !candidate) {
        // No candidate at all: the prompt itself was blocked, or the reply is unreadable.
        const blocked = data?.promptFeedback?.blockReason;
        throw new AssistantProviderError(
          blocked ? `The model provider declined the request (${/^[A-Z_]{1,40}$/.test(blocked) ? blocked : 'blocked'}).` : 'The model provider sent a reply that could not be read.',
          response.status,
        );
      }

      return {
        text: (candidate.content?.parts ?? [])
          .filter((part) => !part.thought && typeof part.text === 'string')
          .map((part) => part.text)
          .join(''),
        truncated: candidate.finishReason === 'MAX_TOKENS',
        inputTokens: data.usageMetadata?.promptTokenCount,
        outputTokens: data.usageMetadata?.candidatesTokenCount,
      };
    },
  };
}
