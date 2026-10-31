import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '../../config/env.js';
import {
  catalogOrder,
  entitlementLabels,
  formatPrice,
  limitText,
  planCatalog,
  planOrder,
  plannedEntitlements,
  type BillingCurrency,
  type EntitlementKey,
} from '../entitlements/plan-catalog.js';
import { uniqueSlugs, uniqueSlugsAvoiding } from './text.js';

/**
 * What the product assistant answers from, and nothing else.
 *
 * The public documents in docs/, split into sections, plus the plan catalog
 * rendered as text so prices and limits come from the same object checkout
 * reads. Every section carries the public URL it is published at, using the
 * heading ids the web renders, so a source link lands on the paragraph.
 *
 * Read from disk once and cached. A missing docs/ directory is not fatal: the
 * plan catalog is still there, and the boot log says what is missing. The API
 * container has to ship docs/ for the assistant to know anything else.
 */

export type ChunkKind = 'faq' | 'guide' | 'api' | 'legal' | 'plans';

export interface CorpusChunk {
  /** Stable across loads while the heading is unchanged: logged as "closest". */
  id: string;
  kind: ChunkKind;
  /** The page as a reader names it: "FAQ", "Setup guide", "Pricing". */
  page: string;
  /** The h2 section, without its clause number. Null for a page's opening. */
  section: string | null;
  /** The question (FAQ) or the heading the text sits under. */
  heading: string;
  /** Public path with the heading anchor: "/faq#getting-set-up". */
  url: string;
  text: string;
}

export interface CorpusDocument {
  key: string;
  file: string;
  page: string;
  path: string;
  kind: ChunkKind;
  /** Being written; loaded when present and not reported missing otherwise. */
  optional?: boolean;
}

/**
 * The documents, with the page each is published at (apps/web/lib/legal-docs.ts
 * for the slugs). The API changelog is not here: no page renders it, so a link
 * to it would go nowhere, and docs/API.md covers what the API offers.
 */
export const CORPUS_DOCUMENTS: readonly CorpusDocument[] = [
  { key: 'faq', file: 'FAQ.md', page: 'FAQ', path: '/faq', kind: 'faq' },
  { key: 'guide', file: 'GUIDE.md', page: 'Setup guide', path: '/guide', kind: 'guide' },
  { key: 'api', file: 'API.md', page: 'API reference', path: '/docs/api', kind: 'api', optional: true },
  { key: 'privacy', file: 'PRIVACY-POLICY.md', page: 'Privacy Policy', path: '/privacy', kind: 'legal' },
  { key: 'terms', file: 'TERMS-OF-SERVICE.md', page: 'Terms of Service', path: '/terms', kind: 'legal' },
  { key: 'dpa', file: 'DPA.md', page: 'Data Processing Agreement', path: '/dpa', kind: 'legal' },
  { key: 'refunds', file: 'REFUND-POLICY.md', page: 'Refund Policy', path: '/refunds', kind: 'legal' },
  { key: 'acceptable-use', file: 'ACCEPTABLE-USE-POLICY.md', page: 'Acceptable Use Policy', path: '/acceptable-use', kind: 'legal' },
  { key: 'cookies', file: 'COOKIE-POLICY.md', page: 'Cookie Policy', path: '/cookies', kind: 'legal' },
  { key: 'complaints', file: 'COMPLAINT-POLICY.md', page: 'Complaint Policy', path: '/complaints', kind: 'legal' },
  { key: 'security', file: 'SECURITY.md', page: 'Security Policy', path: '/security', kind: 'legal' },
  { key: 'sub-processors', file: 'SUB-PROCESSORS.md', page: 'Sub-processors', path: '/sub-processors', kind: 'legal' },
];

/** The same address apps/web/lib/legal-docs.ts substitutes for [SUPPORT EMAIL]. */
export const SUPPORT_EMAIL = 'support@dmarcharbor.com';
export const SUPPORT_PATH = '/support';

/**
 * Facts the business has not supplied yet stay visibly unsupplied, the way the
 * web renders them as pending, so the model reads "not yet published" and
 * cannot fill the gap with something plausible.
 */
const SUBSTITUTIONS: Array<[RegExp, string]> = [
  [/`?\[SUPPORT EMAIL\]`?/g, SUPPORT_EMAIL],
  [/`?\[EFFECTIVE DATE\]`?/g, 'to be set at launch'],
  [/`?\[YOUR LEGAL ENTITY NAME\]`?/g, '(legal entity name not yet published)'],
  [/`?\[[A-Z][A-Z0-9 _-]{2,}\]`?/g, '(not yet published)'],
];

/** Lines that only date or attribute a document. */
const METADATA_LINE = /^\*\*(effective date|version|legal entity|last updated):?\*\*/i;

/** A section longer than this is split, so one excerpt stays a few hundred tokens. */
const MAX_CHUNK_CHARS = 1400;
const MIN_CHUNK_CHARS = 20;

function substitute(markdown: string): string {
  let text = markdown;
  for (const [pattern, value] of SUBSTITUTIONS) text = text.replace(pattern, value);
  return text;
}

/** Fences as apps/web/components/harbor/legal-markdown.ts reads them: nothing inside is markdown. */
const FENCE_OPEN = /^```\s*([A-Za-z0-9_+.-]*)\s*$/;
const FENCE_CLOSE = /^```\s*$/;
/** Lines of one code example kept in an excerpt: enough to show its shape, not to fill the budget. */
const MAX_CODE_LINES = 12;

interface SourceLine {
  text: string;
  fenced: boolean;
}

/** Markdown to the plain text an excerpt carries: no emphasis, no rules, tables as rows, code shortened. */
function clean(lines: SourceLine[]): string {
  const out: string[] = [];
  let codeLines = 0;
  for (const { text: raw, fenced } of lines) {
    if (fenced) {
      if (FENCE_OPEN.test(raw) || FENCE_CLOSE.test(raw)) {
        codeLines = 0;
        continue;
      }
      codeLines += 1;
      if (codeLines <= MAX_CODE_LINES) out.push(raw.trimEnd());
      else if (codeLines === MAX_CODE_LINES + 1) out.push('…');
      continue;
    }
    const line = raw.trimEnd();
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) continue;
    if (/^\|[\s:|-]+\|$/.test(line.trim())) continue;
    if (METADATA_LINE.test(line.trim())) continue;
    // A screenshot on a line of its own says nothing an answer can quote.
    if (/^\s*!\[[^\]]*\]\([^)]*\)(\{[^}]*\})?\s*$/.test(line)) continue;
    out.push(
      line
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/^\s*\|\s?/, '')
        .replace(/\s?\|\s*$/, '')
        .replace(/\s\|\s/g, ' | ')
        .trim(),
    );
  }
  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** "6. Order process" -> "Order process". */
function withoutClauseNumber(heading: string): string {
  return heading.replace(/^\d+(?:\.\d+)*\.?\s+/, '').replace(/[`*]/g, '').trim();
}

/** A long run of lines in pieces of about MAX_CHUNK_CHARS, cut at blank lines outside code. */
function bySize(lines: SourceLine[]): SourceLine[][] {
  if (clean(lines).length <= MAX_CHUNK_CHARS) return [lines];
  const pieces: SourceLine[][] = [];
  let buffer: SourceLine[] = [];
  for (const line of lines) {
    buffer.push(line);
    if (!line.fenced && line.text.trim() === '' && clean(buffer).length > MAX_CHUNK_CHARS * 0.8) {
      pieces.push(buffer);
      buffer = [];
    }
  }
  if (buffer.some((line) => line.text.trim())) pieces.push(buffer);
  return pieces;
}

interface Part {
  heading: string | null;
  anchor: string | null;
  lines: SourceLine[];
}

interface Section {
  heading: string | null;
  anchor: string | null;
  parts: Part[];
}

/**
 * One document to sections, with the anchors the web gives its headings.
 *
 * As legal-markdown.ts reads a document: a line starting "## " is an h2 and
 * "### " an h3, except inside a fenced code block. Section ids are the slugs
 * of every h2 in order, with -2, -3 for repeats. Sub-heading ids exist only on
 * the developer documents (subheadingAnchors), and never take a section's id.
 * So an API reference endpoint links to its own heading, and a long legal
 * section's parts link to the section.
 */
export function parseDocument(markdown: string, doc: CorpusDocument): CorpusChunk[] {
  const marked: Array<SourceLine & { level: 0 | 2 | 3 }> = [];
  let inFence = false;
  for (const text of substitute(markdown).split(/\r?\n/)) {
    if (inFence) {
      marked.push({ text, fenced: true, level: 0 });
      if (FENCE_CLOSE.test(text)) inFence = false;
    } else if (FENCE_OPEN.test(text)) {
      inFence = true;
      marked.push({ text, fenced: true, level: 0 });
    } else if (/^###\s+/.test(text)) {
      marked.push({ text: text.replace(/^###\s+/, ''), fenced: false, level: 3 });
    } else if (/^##\s+/.test(text)) {
      marked.push({ text: text.replace(/^##\s+/, ''), fenced: false, level: 2 });
    } else if (!/^#\s+/.test(text)) {
      // A "# " line is the document's own title, which is the page heading.
      marked.push({ text, fenced: false, level: 0 });
    }
  }

  const h2Ids = uniqueSlugs(marked.filter((line) => line.level === 2).map((line) => line.text));
  const subAnchors = doc.kind === 'api';
  const h3Ids = subAnchors ? uniqueSlugsAvoiding(marked.filter((line) => line.level === 3).map((line) => line.text), h2Ids) : [];

  const sections: Section[] = [{ heading: null, anchor: null, parts: [{ heading: null, anchor: null, lines: [] }] }];
  let h2n = 0;
  let h3n = 0;
  for (const line of marked) {
    if (line.level === 2) {
      sections.push({ heading: line.text.trim(), anchor: h2Ids[h2n++] ?? null, parts: [{ heading: null, anchor: null, lines: [] }] });
      continue;
    }
    const section = sections[sections.length - 1]!;
    if (line.level === 3) {
      section.parts.push({ heading: line.text.trim(), anchor: subAnchors ? (h3Ids[h3n++] ?? null) : null, lines: [] });
      continue;
    }
    section.parts[section.parts.length - 1]!.lines.push({ text: line.text, fenced: line.fenced });
  }

  const chunks: CorpusChunk[] = [];
  const seenIds = new Map<string, number>();
  const push = (idBase: string, chunk: Omit<CorpusChunk, 'id'>) => {
    if (chunk.text.length < MIN_CHUNK_CHARS) return;
    const n = (seenIds.get(idBase) ?? 0) + 1;
    seenIds.set(idBase, n);
    chunks.push({ id: n > 1 ? `${idBase}~${n}` : idBase, ...chunk });
  };

  for (const section of sections) {
    const sectionName = section.heading ? withoutClauseNumber(section.heading) : null;
    const sectionUrl = section.anchor ? `${doc.path}#${section.anchor}` : doc.path;
    const base = `${doc.key}#${section.anchor ?? 'top'}`;
    const fallback = sectionName ?? doc.page;
    // Every line of the section, a sub-heading kept as a line of text.
    const whole: SourceLine[] = section.parts.flatMap((part) => [
      ...(part.heading ? [{ text: withoutClauseNumber(part.heading), fenced: false }] : []),
      ...part.lines,
    ]);

    if (doc.kind === 'faq') {
      // A question is a bold line on its own; its answer runs to the next one.
      let heading = fallback;
      let isQuestion = false;
      let buffer: SourceLine[] = [];
      const flush = () => {
        push(isQuestion ? `${base}/${slugQuestion(heading)}` : base, {
          kind: doc.kind,
          page: doc.page,
          section: sectionName,
          heading,
          url: sectionUrl,
          text: clean(buffer),
        });
        buffer = [];
      };
      for (const line of whole) {
        const question = line.fenced ? null : /^\*\*(.+)\*\*\s*$/.exec(line.text.trim());
        if (question && !METADATA_LINE.test(line.text.trim())) {
          flush();
          heading = question[1]!.trim();
          isQuestion = true;
          continue;
        }
        buffer.push(line);
      }
      flush();
      continue;
    }

    const parts =
      subAnchors || clean(whole).length > MAX_CHUNK_CHARS
        ? section.parts.map((part) => ({
            heading: part.heading ? withoutClauseNumber(part.heading) : fallback,
            url: part.anchor ? `${doc.path}#${part.anchor}` : sectionUrl,
            idBase: part.heading ? `${base}/${slugQuestion(part.heading)}` : base,
            lines: part.lines,
          }))
        : [{ heading: fallback, url: sectionUrl, idBase: base, lines: whole }];

    for (const part of parts) {
      for (const piece of bySize(part.lines)) {
        push(part.idBase, {
          kind: doc.kind,
          page: doc.page,
          section: sectionName,
          heading: part.heading,
          url: part.url,
          text: clean(piece),
        });
      }
    }
  }

  return chunks;
}

function slugQuestion(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'item'
  );
}

/** Money as the pricing page prints a unit price: "$2.00", "₹169". */
function unitMoney(minor: number, currency: BillingCurrency): string {
  const major = minor / 100;
  const digits = currency === 'USD' || !Number.isInteger(major) ? 2 : 0;
  const formatted = new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: 2,
  }).format(major);
  return `${currency === 'INR' ? '\u20b9' : '$'}${formatted}`;
}

const listedKeys = (): EntitlementKey[] =>
  (Object.keys(entitlementLabels) as EntitlementKey[]).filter((key) => !plannedEntitlements.includes(key));

function sentenceList(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join('; ')}; and ${items[items.length - 1]}`;
}

/**
 * The plan catalog as text: one section per plan, an overview, and where each
 * feature starts. Built from planCatalog, so a price change reaches the
 * assistant on the next start with no copy to update.
 */
export function planCatalogChunks(): CorpusChunk[] {
  const chunks: CorpusChunk[] = [];
  const priceLine = (tier: (typeof catalogOrder)[number]): string => {
    const plan = planCatalog[tier];
    if (plan.pricing === 'per_domain') {
      const bands = (plan.bands ?? []).map((band, index, all) => {
        const from = index === 0 ? 1 : (all[index - 1]?.upTo ?? 0) + 1;
        return `${from} to ${band.upTo.toLocaleString('en-US')} active domains: ${unitMoney(band.unitMinor.USD, 'USD')} (${unitMoney(band.unitMinor.INR, 'INR')}) per domain a month, at least ${band.minimumQuantity.toLocaleString('en-US')} domains billed`;
      });
      return `Priced per active domain each month, billed monthly only. ${sentenceList(bands)}.`;
    }
    if (plan.prices.USD.monthlyMinor === 0) return 'Price: free.';
    return `Price: ${formatPrice(tier, 'USD', 'monthly')} a month or ${formatPrice(tier, 'USD', 'annual')} a year in US dollars; ${formatPrice(tier, 'INR', 'monthly')} a month or ${formatPrice(tier, 'INR', 'annual')} a year in Indian rupees.`;
  };

  const overview = catalogOrder.map((tier) => {
    const plan = planCatalog[tier];
    return `${plan.label}: ${plan.descriptor} ${priceLine(tier)}`;
  });
  chunks.push({
    id: 'pricing#plans',
    kind: 'plans',
    page: 'Pricing',
    section: 'Plans and prices',
    heading: 'Plans and prices',
    url: '/pricing',
    text: overview.join('\n'),
  });

  for (const tier of catalogOrder) {
    const plan = planCatalog[tier];
    const granted = listedKeys().filter((key) => plan.features[key]);
    const missing = listedKeys().filter((key) => !plan.features[key]);
    const members = Number.isFinite(plan.maxMembers) ? `${plan.maxMembers} team members per workspace` : 'an unlimited team';
    const prospects =
      plan.maxProspectReportsPerMonth > 0 ? `${plan.maxProspectReportsPerMonth} prospect reports a month` : 'no prospect reports';
    const text = [
      `${plan.label} plan. ${plan.descriptor}`,
      priceLine(tier),
      `Limits: up to ${limitText(plan.maxClients)} clients and ${limitText(plan.maxActiveDomains)} active domains, ${members}, up to ${plan.maxWorkspaces} workspaces per account, and ${prospects}.`,
      `Includes: ${granted.map((key) => entitlementLabels[key]).join('; ')}.`,
      missing.length > 0 ? `Not included: ${missing.map((key) => entitlementLabels[key]).join('; ')}.` : 'Every listed feature is included.',
    ].join('\n');
    chunks.push({
      id: `pricing#plan-${tier}`,
      kind: 'plans',
      page: 'Pricing',
      section: `${plan.label} plan`,
      heading: `${plan.label} plan`,
      url: `/pricing#plan-${tier}`,
      text,
    });
  }

  const starts = listedKeys().map((key) => {
    const first = planOrder.find((tier) => planCatalog[tier].features[key]);
    const onFleet = planCatalog.FLEET.features[key];
    if (!first) return `${entitlementLabels[key]}: ${onFleet ? 'Fleet only' : 'not on any plan'}`;
    if (first === planOrder[0]) return `${entitlementLabels[key]}: every plan, free included`;
    return `${entitlementLabels[key]}: ${planCatalog[first].label} and above${onFleet ? ', and Fleet' : ''}`;
  });
  chunks.push({
    id: 'pricing#compare',
    kind: 'plans',
    page: 'Pricing',
    section: 'Compare everything',
    heading: 'Which plan each feature starts on',
    url: '/pricing#compare-head',
    text: starts.join('\n'),
  });

  return chunks;
}

export interface Corpus {
  chunks: CorpusChunk[];
  /** Files read, by name. */
  loaded: string[];
  /** Required files that were not found. */
  missing: string[];
  docsDir: string | null;
  /** Changes whenever any section's text does, so cached answers cannot outlive their source. */
  version: string;
}

/** Where docs/ is: configured, or beside the repository root in a checkout and in the image. */
export function findDocsDirectory(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    env.ASSISTANT_DOCS_DIR,
    resolve(process.cwd(), '..', '..', 'docs'),
    resolve(process.cwd(), 'docs'),
    // src/services/assistant and dist/services/assistant are both five levels below the root.
    resolve(here, '..', '..', '..', '..', '..', 'docs'),
  ].filter((value): value is string => Boolean(value));
  return candidates.find((dir) => existsSync(join(dir, 'FAQ.md'))) ?? null;
}

export function loadCorpus(options: { docsDir?: string | null; documents?: readonly CorpusDocument[] } = {}): Corpus {
  const docsDir = options.docsDir === undefined ? findDocsDirectory() : options.docsDir;
  const chunks: CorpusChunk[] = [];
  const loaded: string[] = [];
  const missing: string[] = [];

  for (const doc of options.documents ?? CORPUS_DOCUMENTS) {
    const path = docsDir ? join(docsDir, doc.file) : null;
    if (!path || !existsSync(path)) {
      if (!doc.optional) missing.push(doc.file);
      continue;
    }
    try {
      chunks.push(...parseDocument(readFileSync(path, 'utf8'), doc));
      loaded.push(doc.file);
    } catch {
      missing.push(doc.file);
    }
  }
  chunks.push(...planCatalogChunks());

  const version = createHash('sha256')
    .update(chunks.map((chunk) => `${chunk.id}\n${chunk.text}`).join('\n\n'))
    .digest('hex')
    .slice(0, 16);

  return { chunks, loaded, missing, docsDir, version };
}

let cached: Corpus | null = null;

/** The corpus, read once per process. */
export function getCorpus(): Corpus {
  if (!cached) {
    cached = loadCorpus();
    if (cached.missing.length > 0) {
      console.warn(
        `[assistant] ${cached.missing.length} document(s) not found (${cached.missing.join(', ')}); ` +
          'the assistant answers from what it has. Ship docs/ with the API to include them.',
      );
    }
    console.info(`[assistant] corpus ready: ${cached.chunks.length} sections from ${cached.loaded.length} document(s) and the plan catalog`);
  }
  return cached;
}

/** For tests and a docs reload. */
export function resetCorpusCache(): void {
  cached = null;
}
