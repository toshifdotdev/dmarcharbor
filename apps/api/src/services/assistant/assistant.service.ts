import { createHash } from 'node:crypto';
import { env } from '../../config/env.js';
import { getCorpus, SUPPORT_EMAIL, SUPPORT_PATH, type Corpus, type CorpusChunk } from './corpus.js';
import {
  cacheKey,
  checkQuestion,
  classifyScope,
  normaliseQuestion,
  redact,
  REFUSAL_MESSAGES,
  REFUSALS_WITH_LINKS,
  type InputProblem,
  type RefusalKind,
} from './guardrails.js';
import { buildPrompt, parseModelReply } from './prompt.js';
import { AssistantProviderError, configuredProvider, type AssistantProvider } from './providers/index.js';
import { recordUnansweredQuestion, type UnansweredQuestion, type UnansweredReason } from './question-log.js';
import { buildIndex, pickExcerpts, search, type SearchIndex, type SearchResult } from './retrieval.js';
import { STARTER_GROUPS, type StarterGroup } from './starters.js';
import { tokenize } from './text.js';

/**
 * The product assistant: a question in, a short answer from the docs out.
 *
 * It is given the question and nothing else. No workspace, client, domain,
 * report or member reaches it, the asker's own included, so there is nothing
 * it could reveal. It takes no actions. It answers from the corpus (docs/ and
 * the plan catalog) and from nothing the model might otherwise know:
 *
 *   1. The question is checked (empty, too long, not a question, repeated)
 *      and redacted (emails, links, IPs, domains, keys).
 *   2. Out-of-scope questions are refused before anything else runs.
 *   3. BM25 finds the closest sections. Too little match is "I don't know",
 *      with no model call.
 *   4. With no provider configured, the matching sections come back as links.
 *   5. Otherwise the best four go to the model with the instruction to answer
 *      only from them and cite them; a reply that does not, or that states a
 *      figure its sources do not, is "I don't know" too.
 *
 * Every unanswered question is logged, redacted, with no user or workspace.
 */

/** The share of the question the best section has to match before it is worth answering from. */
export const MIN_COVERAGE = 0.5;
/** A floor on the BM25 score, so one rare stray word is not an answer. */
export const MIN_SCORE = 1;
const EXCERPT_COUNT = 4;
const SEARCH_DEPTH = 8;
/** Excerpts below this share of the best score are not worth paying to send. */
const RELATIVE_FLOOR = 0.3;

const ANSWER_CACHE_SIZE = 300;
const ANSWER_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const REPEAT_WINDOW_MS = 10 * 60 * 1000;
const REPEAT_LIMIT = 3;

export interface AssistantSource {
  id: string;
  /** "FAQ", "Setup guide", "Pricing": set in bold. */
  page: string;
  /** The section, set lighter beside it. Null for a page's opening. */
  section: string | null;
  url: string;
}

export type AssistantOutcome = 'answered' | 'unknown' | 'refused' | 'links_only';
export type AssistantReason = UnansweredReason | 'not_enabled' | RefusalKind | null;

export interface AssistantReply {
  outcome: AssistantOutcome;
  /** Why it is not a written answer. Null when it is one. */
  reason: AssistantReason;
  /** The written answer, when there is one. */
  answer: string | null;
  /** The plain sentence for every other outcome, starting "I don't know" when it is that. */
  message: string | null;
  sources: AssistantSource[];
  /** What the sources are, said above them. */
  sourcesLabel: string | null;
  /** One or two questions taken from the headings of the sections found. */
  followUps: string[];
  support: { url: string; email: string };
  /** "links" when this deployment has no model provider configured. */
  mode: 'written' | 'links';
  cached: boolean;
}

export interface AssistantIntro {
  mode: 'written' | 'links';
  starters: readonly StarterGroup[];
  support: { url: string; email: string };
  maxQuestionChars: number;
  limits: { perMinute: number; perWorkspacePerDay: number };
}

export class AssistantInputError extends Error {
  constructor(
    readonly problem: InputProblem | 'repeated',
    message: string,
    readonly status: 400 | 429,
  ) {
    super(message);
    this.name = 'AssistantInputError';
  }
}

const SUPPORT = { url: SUPPORT_PATH, email: SUPPORT_EMAIL } as const;

export const MESSAGES = {
  noMatch: "I don't know. The product's documentation does not cover that, so I will not guess. Support can answer it.",
  unsure: "I don't know. The closest pages do not answer this clearly, so I will not guess. Support can answer it.",
  notEnabled: 'Written answers are not enabled on this deployment. These pages look relevant to your question.',
  providerError: 'A written answer could not be produced just now. These pages look relevant to your question.',
  repeated:
    'You have asked this several times in the last few minutes, and the answer will not change. If it does not help, ask support.',
} as const;

/** A per-person key for limits and repeat detection. Never stored with a question. */
export function askerKeyFor(userId: string | undefined | null): string {
  return createHash('sha256').update(`assistant:${userId ?? 'anonymous'}`).digest('hex').slice(0, 32);
}

let indexCache: { version: string; index: SearchIndex } | null = null;

function indexOf(corpus: Corpus): SearchIndex {
  if (!indexCache || indexCache.version !== corpus.version) {
    indexCache = { version: corpus.version, index: buildIndex(corpus.chunks) };
  }
  return indexCache.index;
}

/** Recent replies by question, so asking the same thing twice costs one model call. */
class AnswerCache {
  private readonly entries = new Map<string, { at: number; reply: AssistantReply }>();

  get(key: string, now: number): AssistantReply | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (now - entry.at > ANSWER_CACHE_TTL_MS) {
      this.entries.delete(key);
      return null;
    }
    // Re-inserted, so the map's order is least recently used first.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.reply;
  }

  set(key: string, reply: AssistantReply, now: number): void {
    this.entries.delete(key);
    this.entries.set(key, { at: now, reply });
    while (this.entries.size > ANSWER_CACHE_SIZE) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  clear(): void {
    this.entries.clear();
  }
}

export const answerCache = new AnswerCache();

const recentAsks = new Map<string, number[]>();

function noteAsk(askerKey: string, key: string, now: number): void {
  const id = `${askerKey}|${key}`;
  const times = (recentAsks.get(id) ?? []).filter((at) => now - at < REPEAT_WINDOW_MS);
  if (times.length >= REPEAT_LIMIT) throw new AssistantInputError('repeated', MESSAGES.repeated, 429);
  times.push(now);
  recentAsks.delete(id);
  recentAsks.set(id, times);
  while (recentAsks.size > 5000) {
    const oldest = recentAsks.keys().next().value;
    if (oldest === undefined) break;
    recentAsks.delete(oldest);
  }
}

/** For tests: forget cached answers and recent questions. */
export function resetAssistantState(): void {
  answerCache.clear();
  recentAsks.clear();
  indexCache = null;
}

function answerable(results: SearchResult[]): boolean {
  const top = results[0];
  if (!top || top.score < MIN_SCORE) return false;
  return results.slice(0, 3).some((result) => result.coverage >= MIN_COVERAGE);
}

/** The links under an answer: one per published section, page in bold and section beside it. */
export function sourcesOf(chunks: CorpusChunk[]): AssistantSource[] {
  const seen = new Set<string>();
  const out: AssistantSource[] = [];
  const labels = new Set<string>();
  for (const chunk of chunks) {
    if (seen.has(chunk.url)) continue;
    // A sub-section (an endpoint under "Domains" in the API reference) is
    // named by its own heading, so two links never read the same. An FAQ
    // answer keeps its section: the question would make a long link.
    const section =
      chunk.kind !== 'faq' && chunk.section && chunk.heading !== chunk.section
        ? chunk.heading
        : (chunk.section ?? (chunk.heading !== chunk.page ? chunk.heading : null));
    const label = `${chunk.page}\u0000${section ?? ''}`;
    if (labels.has(label)) continue;
    seen.add(chunk.url);
    labels.add(label);
    out.push({ id: chunk.id, page: chunk.page, section, url: chunk.url });
  }
  return out;
}

/**
 * Follow-up questions from the headings of what was found: FAQ questions, and
 * a plan section as "What does the Harbor plan include?". Never one that
 * restates the question just asked or a section already shown.
 */
export function followUpsFrom(question: string, results: SearchResult[], shown: Set<string>): string[] {
  const asked = new Set(tokenize(question));
  const out: string[] = [];
  for (const { chunk } of results) {
    if (shown.has(chunk.id)) continue;
    const heading = chunk.heading.trim();
    const candidate = heading.endsWith('?')
      ? heading
      : chunk.kind === 'plans' && /\splan$/.test(heading)
        ? `What does the ${heading} include?`
        : null;
    if (!candidate || out.includes(candidate)) continue;
    const tokens = new Set(tokenize(candidate));
    const overlap = [...tokens].filter((token) => asked.has(token)).length;
    if (tokens.size > 0 && overlap / Math.min(tokens.size, Math.max(asked.size, 1)) >= 0.8) continue;
    out.push(candidate);
    if (out.length === 2) break;
  }
  return out;
}

export interface AskContext {
  /** Opaque per-person key (askerKeyFor) for repeat detection. Held in memory only. */
  askerKey?: string;
  /** Undefined means the configured provider; null means none (links only). */
  provider?: AssistantProvider | null;
  corpus?: Corpus;
  record?: (entry: UnansweredQuestion) => Promise<void>;
  now?: number;
}

async function logUnanswered(
  record: (entry: UnansweredQuestion) => Promise<void>,
  entry: UnansweredQuestion,
): Promise<void> {
  try {
    await record(entry);
  } catch (error) {
    // The question is not in the line: the log is not where questions go.
    console.warn(`[assistant] an unanswered question could not be recorded: ${error instanceof Error ? error.name : 'unknown error'}`);
  }
}

export function assistantIntro(provider: AssistantProvider | null = configuredProvider()): AssistantIntro {
  return {
    mode: provider ? 'written' : 'links',
    starters: STARTER_GROUPS,
    support: { ...SUPPORT },
    maxQuestionChars: env.ASSISTANT_MAX_QUESTION_CHARS,
    limits: { perMinute: env.ASSISTANT_RATE_LIMIT_PER_MINUTE, perWorkspacePerDay: env.ASSISTANT_WORKSPACE_DAILY_LIMIT },
  };
}

export async function askAssistant(raw: unknown, context: AskContext = {}): Promise<AssistantReply> {
  const now = context.now ?? Date.now();
  const question = normaliseQuestion(raw);
  const check = checkQuestion(question, env.ASSISTANT_MAX_QUESTION_CHARS);
  if (!check.ok) throw new AssistantInputError(check.problem, check.message, 400);

  const safe = redact(question);
  const key = cacheKey(safe);
  if (context.askerKey) noteAsk(context.askerKey, key, now);

  const provider = context.provider === undefined ? configuredProvider() : context.provider;
  const mode = provider ? 'written' : 'links';
  const corpus = context.corpus ?? getCorpus();
  const record = context.record ?? recordUnansweredQuestion;
  const results = search(indexOf(corpus), safe, SEARCH_DEPTH);
  const closest = results.slice(0, 3).map((result) => result.chunk.id);

  const reply = (fields: Partial<AssistantReply> & Pick<AssistantReply, 'outcome' | 'reason'>): AssistantReply => ({
    answer: null,
    message: null,
    sources: [],
    sourcesLabel: null,
    followUps: [],
    support: { ...SUPPORT },
    mode,
    cached: false,
    ...fields,
  });

  const refusal = classifyScope(safe);
  if (refusal) {
    await logUnanswered(record, { question: safe, reason: 'refused', closestSourceIds: closest });
    const pool =
      refusal === 'legal_advice' ? results.filter((result) => result.chunk.kind === 'legal') : results;
    const links = REFUSALS_WITH_LINKS.has(refusal) && answerable(results) ? sourcesOf(pickExcerpts(pool, 3).map((r) => r.chunk)) : [];
    return reply({
      outcome: 'refused',
      reason: refusal,
      message: REFUSAL_MESSAGES[refusal],
      sources: links,
      sourcesLabel: links.length > 0 ? 'Pages that may help' : null,
    });
  }

  if (!answerable(results)) {
    await logUnanswered(record, { question: safe, reason: 'no_match', closestSourceIds: closest });
    return reply({ outcome: 'unknown', reason: 'no_match', message: MESSAGES.noMatch });
  }

  const best = results[0]!.score;
  const excerpts = pickExcerpts(
    results.filter((result) => result.score >= best * RELATIVE_FLOOR),
    EXCERPT_COUNT,
  );
  const excerptChunks = excerpts.map((result) => result.chunk);
  const linkReply = (reason: 'not_enabled' | 'provider_error', message: string) =>
    reply({
      outcome: 'links_only',
      reason,
      message,
      sources: sourcesOf(excerptChunks),
      sourcesLabel: 'These pages look relevant',
      followUps: followUpsFrom(question, results, new Set(excerptChunks.map((chunk) => chunk.id))),
    });

  if (!provider) return linkReply('not_enabled', MESSAGES.notEnabled);

  const cacheId = `${corpus.version}|${provider.name}:${provider.model}|${key}`;
  const hit = answerCache.get(cacheId, now);
  if (hit) {
    // Still counted: how often a question goes unanswered is the signal.
    if (hit.reason === 'model_unsure') {
      await logUnanswered(record, { question: safe, reason: 'model_unsure', closestSourceIds: closest });
    }
    return { ...hit, cached: true };
  }

  let parsed: ReturnType<typeof parseModelReply>;
  try {
    const prompt = buildPrompt(safe, excerptChunks);
    const completion = await provider.complete({ ...prompt, maxOutputTokens: env.ASSISTANT_MAX_OUTPUT_TOKENS });
    parsed = parseModelReply(completion.text, excerptChunks, completion.truncated);
  } catch (error) {
    // The provider error's message is built from a status code and is safe to
    // log. Anything else is logged by name only: it could carry the request.
    console.warn(
      `[assistant] ${error instanceof AssistantProviderError ? error.message : `the model call failed (${error instanceof Error ? error.name : 'unknown'})`}`,
    );
    await logUnanswered(record, { question: safe, reason: 'provider_error', closestSourceIds: closest });
    return linkReply('provider_error', MESSAGES.providerError);
  }

  if (parsed.kind === 'unsure') {
    await logUnanswered(record, { question: safe, reason: 'model_unsure', closestSourceIds: closest });
    const unsure = reply({
      outcome: 'unknown',
      reason: 'model_unsure',
      message: MESSAGES.unsure,
      sources: sourcesOf(excerptChunks.slice(0, 2)),
      sourcesLabel: 'Closest pages, which do not answer it clearly',
      followUps: followUpsFrom(question, results, new Set(excerptChunks.slice(0, 2).map((chunk) => chunk.id))),
    });
    answerCache.set(cacheId, unsure, now);
    return unsure;
  }

  const answered = reply({
    outcome: 'answered',
    reason: null,
    answer: parsed.answer,
    sources: sourcesOf(parsed.cited),
    sourcesLabel: 'Sources',
    followUps: followUpsFrom(question, results, new Set(parsed.cited.map((chunk) => chunk.id))),
  });
  answerCache.set(cacheId, answered, now);
  return answered;
}
