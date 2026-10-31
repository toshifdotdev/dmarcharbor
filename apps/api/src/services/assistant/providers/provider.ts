/**
 * A model provider, as the assistant needs one: a system prompt and one user
 * message in, text out. One file per provider beside this one; adding a
 * provider is a new file and a case in index.ts.
 */

export interface CompletionRequest {
  system: string;
  user: string;
  maxOutputTokens: number;
}

export interface CompletionResult {
  text: string;
  /** True when the provider stopped at the token ceiling. */
  truncated: boolean;
  inputTokens?: number;
  outputTokens?: number;
}

export interface AssistantProvider {
  readonly name: string;
  readonly model: string;
  complete(request: CompletionRequest): Promise<CompletionResult>;
}

/**
 * A provider call that did not produce text.
 *
 * The message is written here, from the status and the provider's own short
 * error type, and never from the request: it must be safe to log, so it can
 * never contain the key, the prompt or the question.
 */
export class AssistantProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'AssistantProviderError';
  }
}
