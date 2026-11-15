import { env } from '../../../config/env.js';
import { createAnthropicProvider } from './anthropic.js';
import { createGeminiProvider } from './gemini.js';
import type { AssistantProvider } from './provider.js';

export type { AssistantProvider, CompletionRequest, CompletionResult } from './provider.js';
export { AssistantProviderError } from './provider.js';

/** The model each provider uses when ASSISTANT_MODEL is unset. */
export const defaultModels = {
  anthropic: 'claude-haiku-5-5',
  // Fast (about a second with thinking off) and generally available; checked
  // against the models the key lists on 15 November 2026.
  gemini: 'gemini-3.5-flash',
} as const;

/**
 * The configured provider, or null when no key is set.
 *
 * Null is a supported state, not an error: the assistant then answers with
 * links to the matching sections and says written answers are not enabled on
 * this deployment. That is the local and CI case.
 */
export function providerFromEnv(): AssistantProvider | null {
  const providerKey = env.ASSISTANT_PROVIDER === 'gemini' ? env.GEMINI_API_KEY : env.ANTHROPIC_API_KEY;
  const apiKey = env.ASSISTANT_API_KEY ?? providerKey;
  if (!apiKey) return null;
  const model = env.ASSISTANT_MODEL ?? defaultModels[env.ASSISTANT_PROVIDER];

  switch (env.ASSISTANT_PROVIDER) {
    case 'anthropic':
      return createAnthropicProvider({
        apiKey,
        model,
        timeoutMs: env.ASSISTANT_TIMEOUT_MS,
        temperature: env.ASSISTANT_TEMPERATURE,
      });
    case 'gemini':
      return createGeminiProvider({
        apiKey,
        model,
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
