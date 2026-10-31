import { env } from '../../config/env.js';
import { prisma } from '../../database/prisma.js';
import { buildPage, type Page } from '../../utils/pagination.js';

/**
 * The questions the assistant could not answer, for whoever improves the docs.
 *
 * Only what that needs: the question as it was sent (already redacted, so it
 * holds no email address, domain, IP or key), why it went unanswered, the
 * sections that came closest, and when. No user, no workspace, no address,
 * so the table is not workspace data and an erasure has nothing to find in it.
 */

export const UNANSWERED_REASONS = ['no_match', 'model_unsure', 'refused', 'provider_error'] as const;
export type UnansweredReason = (typeof UNANSWERED_REASONS)[number];

const MAX_QUESTION = 500;
const MAX_SOURCES = 5;

export interface UnansweredQuestion {
  question: string;
  reason: UnansweredReason;
  closestSourceIds: string[];
}

export async function recordUnansweredQuestion(entry: UnansweredQuestion): Promise<void> {
  await prisma.assistantQuestion.create({
    data: {
      question: entry.question.trim().slice(0, MAX_QUESTION),
      reason: entry.reason,
      closestSourceIds: entry.closestSourceIds.slice(0, MAX_SOURCES).map((id) => id.slice(0, 200)),
    },
  });
}

export interface UnansweredQuestionRow {
  id: string;
  question: string;
  reason: string;
  closestSourceIds: string[];
  createdAt: Date;
}

/** Newest first, paged by id, optionally one reason. */
export async function listUnansweredQuestions(options: {
  limit: number;
  cursor?: string;
  reason?: UnansweredReason;
}): Promise<Page<UnansweredQuestionRow>> {
  const rows = await prisma.assistantQuestion.findMany({
    where: options.reason ? { reason: options.reason } : undefined,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: options.limit + 1,
    ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
    select: { id: true, question: true, reason: true, closestSourceIds: true, createdAt: true },
  });
  return buildPage(rows, options.limit);
}

/** Deletes rows past the retention window. Called from the hourly retention sweep. */
export async function purgeOldAssistantQuestions(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - env.ASSISTANT_QUESTION_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const removed = await prisma.assistantQuestion.deleteMany({ where: { createdAt: { lt: cutoff } } });
  return removed.count;
}
