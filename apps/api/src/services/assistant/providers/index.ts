import { env } from '../../../config/env.js';
import { createAnthropicProvider } from './anthropic.js';
import type { AssistantProvider } from './provider.js';

export type { AssistantProvider, CompletionRequest, CompletionResult } from './provider.js';
export { AssistantProviderError } from './provider.js';

/**
 * The configured provider, or null when no key is set.
 *
 * Null is a supported state, not an error: the assistant then answers with
 * links to the matching sections and says written answers are not enabled on
 * this deployment. That is the local and CI case.
 */
export function providerFromEnv(): AssistantProvider | null {
  const apiKey = env.ASSISTANT_API_KEY ?? (env.ASSISTANT_PROVIDER === 'anthropic' ? env.ANTHROPIC_API_KEY : undefined);
  if (!apiKey) return null;

  switch (env.ASSISTANT_PROVIDER) {
    case 'anthropic':
      return createAnthropicProvider({
        apiKey,
        model: env.ASSISTANT_MODEL,
        timeoutMs: env.ASSISTANT_TIMEOUT_MS,
        temperature: env.ASSISTANT_TEMPERATURE,
      });
    default:
      return null;
  }
}

let configured: AssistantProvider | null | undefined;

/** Read once per process: the environment does not change while it runs. */
export function configuredProvider(): AssistantProvider | null {
  if (configured === undefined) configured = providerFromEnv();
  return configured;
}
