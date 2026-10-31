import type { CorpusChunk } from './corpus.js';
import { expandPhrases, SYNONYMS, tokenize } from './text.js';

/**
 * BM25 over the corpus, in memory.
 *
 * A few hundred sections fit in a map, so there is no vector store and no
 * package: a question is tokenized the way the sections were, each section is
 * scored with BM25, and the heading counts twice because a section whose
 * heading names the topic is usually the one that answers it.
 *
 * Besides the score, each result carries its coverage: the share of the
 * question's weight (by IDF) that the section matched. The score orders the
 * results; coverage decides whether the best of them answers the question at
 * all, because a high score on one common word ("domain") is not an answer.
 */

const K1 = 1.2;
const B = 0.75;
const HEADING_WEIGHT = 2;

/** How much a matched variant counts, against the question's own word. */
const EXACT = 1;
const RELATED = 0.8;
const SYNONYM = 0.5;

interface IndexedChunk {
  chunk: CorpusChunk;
  tf: Map<string, number>;
  length: number;
}

export interface SearchIndex {
  chunks: IndexedChunk[];
  df: Map<string, number>;
  avgLength: number;
  /** Vocabulary by its first four characters, for the related-word match. */
  byPrefix: Map<string, string[]>;
}

export interface SearchResult {
  chunk: CorpusChunk;
  score: number;
  /** 0 to 1: how much of the question this section matched. */
  coverage: number;
}

export function chunkTokens(chunk: CorpusChunk): string[] {
  const heading = tokenize(expandPhrases(chunk.heading));
  return [
    ...Array.from({ length: HEADING_WEIGHT }, () => heading).flat(),
    ...tokenize(expandPhrases(chunk.section ?? '')),
    ...tokenize(expandPhrases(chunk.page)),
    ...tokenize(expandPhrases(chunk.text)),
  ];
}

export function buildIndex(chunks: CorpusChunk[]): SearchIndex {
  const indexed: IndexedChunk[] = [];
  const df = new Map<string, number>();
  let total = 0;

  for (const chunk of chunks) {
    const tokens = chunkTokens(chunk);
    const tf = new Map<string, number>();
    for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
    for (const token of tf.keys()) df.set(token, (df.get(token) ?? 0) + 1);
    indexed.push({ chunk, tf, length: tokens.length });
    total += tokens.length;
  }

  const byPrefix = new Map<string, string[]>();
  for (const term of df.keys()) {
    if (term.length < 5) continue;
    const key = term.slice(0, 4);
    const list = byPrefix.get(key);
    if (list) list.push(term);
    else byPrefix.set(key, [term]);
  }

  return { chunks: indexed, df, avgLength: indexed.length ? total / indexed.length : 1, byPrefix };
}

function idf(index: SearchIndex, df: number): number {
  const n = index.chunks.length;
  return Math.log(1 + (n - df + 0.5) / (df + 0.5));
}

/** Two stems of one word: "verifi" and "verification", "member" and "membership". */
function related(a: string, b: string): boolean {
  const shortest = Math.min(a.length, b.length);
  let common = 0;
  while (common < shortest && a[common] === b[common]) common += 1;
  return common >= 5 && common >= 0.8 * shortest;
}

interface QueryGroup {
  token: string;
  /** Vocabulary term to how much it counts for this word. */
  variants: Map<string, number>;
  weight: number;
}

export function queryGroups(index: SearchIndex, question: string): QueryGroup[] {
  const tokens = [...new Set(tokenize(expandPhrases(question)))];
  return tokens.map((token) => {
    const variants = new Map<string, number>();
    const offer = (term: string, weight: number) => {
      if (index.df.has(term) && (variants.get(term) ?? 0) < weight) variants.set(term, weight);
    };
    offer(token, EXACT);
    if (token.length >= 5) {
      for (const term of index.byPrefix.get(token.slice(0, 4)) ?? []) {
        if (term !== token && related(token, term)) offer(term, RELATED);
      }
    }
    for (const synonym of SYNONYMS.get(token) ?? []) offer(synonym, SYNONYM);

    // The word's weight is its own IDF. One the corpus only uses in another
    // form ("annually", "annual") weighs as that form does. One it never uses
    // at all weighs as much as the rarest word: asking about something the
    // documentation does not mention should lower coverage, not vanish from
    // the sum.
    const own = index.df.get(token);
    const relatedDf = [...variants]
      .filter(([, weight]) => weight === RELATED)
      .map(([term]) => index.df.get(term) ?? 0);
    const weight = own !== undefined ? idf(index, own) : idf(index, relatedDf.length > 0 ? Math.max(...relatedDf) : 0);
    return { token, variants, weight };
  });
}

export function search(index: SearchIndex, question: string, limit = 8): SearchResult[] {
  const groups = queryGroups(index, question);
  const totalWeight = groups.reduce((sum, group) => sum + group.weight, 0);
  if (groups.length === 0 || totalWeight === 0) return [];

  const results: SearchResult[] = [];
  for (const entry of index.chunks) {
    let score = 0;
    let covered = 0;
    for (const group of groups) {
      let best = 0;
      let bestWeight = 0;
      for (const [term, weight] of group.variants) {
        const tf = entry.tf.get(term);
        if (!tf) continue;
        const termIdf = idf(index, index.df.get(term) ?? 0);
        const part = (termIdf * tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * entry.length) / index.avgLength));
        if (weight * part > best) best = weight * part;
        if (weight > bestWeight) bestWeight = weight;
      }
      score += best;
      covered += bestWeight * group.weight;
    }
    if (score > 0) results.push({ chunk: entry.chunk, score, coverage: covered / totalWeight });
  }

  results.sort((a, b) => b.score - a.score || a.chunk.id.localeCompare(b.chunk.id));
  return results.slice(0, limit);
}

/**
 * The excerpts to send: the best few, at most two from one published section,
 * so four excerpts are not four paragraphs of the same page.
 */
export function pickExcerpts(results: SearchResult[], count: number): SearchResult[] {
  const picked: SearchResult[] = [];
  const perUrl = new Map<string, number>();
  for (const result of results) {
    const n = perUrl.get(result.chunk.url) ?? 0;
    if (n >= 2) continue;
    perUrl.set(result.chunk.url, n + 1);
    picked.push(result);
    if (picked.length >= count) break;
  }
  return picked;
}
