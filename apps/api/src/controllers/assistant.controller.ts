import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  AssistantInputError,
  askAssistant,
  askerKeyFor,
  assistantIntro,
} from '../services/assistant/assistant.service.js';
import { listUnansweredQuestions, UNANSWERED_REASONS, type UnansweredReason } from '../services/assistant/question-log.js';
import { sendError } from '../utils/api-error.js';
import { parsePagination } from '../utils/pagination.js';

/**
 * The product assistant's routes.
 *
 * The workspace in the path decides only whether the plan carries the
 * assistant and whose daily budget a question spends. It is never passed to
 * the assistant, which receives the question text and nothing else.
 */

/** Generous: the length rule with its own message is in the service. */
const askSchema = z.object({ question: z.string().max(4000) });

export function assistantIntroController(_request: Request, response: Response): void {
  response.json(assistantIntro());
}

export async function askAssistantController(request: Request, response: Response): Promise<void> {
  const body = askSchema.safeParse(request.body);
  if (!body.success) {
    sendError(response, 400, 'Send the question as text: { "question": "..." }.', { reason: 'invalid' });
    return;
  }

  try {
    const userId = (response.locals.session as { user?: { id?: string } } | undefined)?.user?.id;
    response.json(await askAssistant(body.data.question, { askerKey: askerKeyFor(userId) }));
  } catch (error) {
    if (error instanceof AssistantInputError) {
      sendError(response, error.status, error.message, { reason: error.problem });
      return;
    }
    // Logged by name: the question is not something the log should hold.
    console.error(
      `[assistant] ${response.locals.requestId ?? 'no-request-id'} ask failed: ${error instanceof Error ? error.name : 'unknown error'}`,
    );
    sendError(response, 500, 'The question could not be answered just now. Try again, or ask support.');
  }
}

export async function listAssistantQuestionsController(request: Request, response: Response): Promise<void> {
  const page = parsePagination(request, response);
  if (!page.ok) return;

  const rawReason = request.query.reason;
  let reason: UnansweredReason | undefined;
  if (rawReason !== undefined) {
    if (typeof rawReason !== 'string' || !(UNANSWERED_REASONS as readonly string[]).includes(rawReason)) {
      sendError(response, 400, `reason must be one of ${UNANSWERED_REASONS.join(', ')}.`);
      return;
    }
    reason = rawReason as UnansweredReason;
  }

  try {
    const result = await listUnansweredQuestions({ limit: page.limit, cursor: page.cursor, reason });
    response.json({
      ...result,
      items: result.items.map((item) => ({ ...item, createdAt: item.createdAt.toISOString() })),
    });
  } catch (error) {
    console.error(
      `[assistant] ${response.locals.requestId ?? 'no-request-id'} question list failed: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
    sendError(response, 500, 'The unanswered questions could not be read.');
  }
}
