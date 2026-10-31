/**
 * Text helpers for the product assistant: the heading slugs the web app
 * renders, and the tokenizer the retrieval ranks with.
 *
 * `slugify`, `uniqueSlugs` and `uniqueSlugsAvoiding` mirror slugify,
 * uniqueIds and uniqueIdsAvoiding in apps/web/components/harbor/legal-markdown.ts
 * (used by legal-render.tsx), because every source link the assistant shows
 * has to land on the heading the public page renders. The web file is the
 * source of truth; tests/assistant.unit.test.ts compares the two slugify
 * bodies and pins known anchors, so a change on either side is noticed.
 */

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

/** Ids for a document's h2 headings, in order, with the web's -2, -3 suffixes. */
export function uniqueSlugs(texts: string[]): string[] {
  const seen = new Map<string, number>();
  return texts.map((text) => {
    const base = slugify(text) || 'section';
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n ? `${base}-${n + 1}` : base;
  });
}

/** Ids for sub-headings that never take an id the sections already have. */
export function uniqueSlugsAvoiding(texts: string[], taken: Iterable<string>): string[] {
  const used = new Set(taken);
  return texts.map((text) => {
    const base = slugify(text) || 'section';
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
    used.add(id);
    return id;
  });
}

/**
 * Words that carry no meaning for ranking. Deliberately short: "not", "no",
 * "free" and "own" stay, because "not included" and "free plan" are questions.
 */
const STOPWORDS = new Set(
  [
    'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am',
    'do', 'does', 'did', 'doing', 'done',
    'how', 'what', 'when', 'where', 'which', 'who', 'whom', 'why', 'whose',
    'can', 'could', 'should', 'would', 'will', 'shall', 'may', 'might', 'must',
    'i', 'me', 'my', 'mine', 'we', 'us', 'our', 'ours', 'you', 'your', 'yours',
    'it', 'its', 'they', 'them', 'their', 'he', 'she', 'his', 'her',
    'of', 'to', 'in', 'on', 'for', 'with', 'and', 'or', 'but', 'if', 'then',
    'this', 'that', 'these', 'those', 'there', 'here', 'at', 'by', 'from', 'as',
    'about', 'into', 'than', 'so', 'such', 'too', 'very', 'just', 'also',
    'have', 'has', 'had', 'having', 'get', 'got', 'gets', 'any', 'some', 'all',
    'each', 'every', 'per', 'up', 'out', 'over', 'again', 'please', 'tell',
    'know', 'want', 'need', 'like', 'way', 'thing', 'things', 'one',
    // How a question is framed, not what it is about: "the difference between
    // Harbor and Admiralty" is a question about Harbor and Admiralty.
    'difference', 'different', 'differ', 'compare', 'comparison', 'versus', 'vs', 'between',
    'mean', 'means', 'explain', 'describe', 'much', 'many', 'really', 'actually', 'exactly',
  ],
);

/**
 * A light suffix stemmer, applied the same way to the corpus and to a
 * question, so "pricing", "priced" and "price" meet at "pric", and
 * "policies" and "policy" at "policy". Not Porter: it only has to be
 * consistent with itself.
 */
export function stem(word: string): string {
  let w = word;
  if (w.length <= 3 || /^\d/.test(w)) return w;
  if (w.endsWith('ies') && w.length > 4) w = `${w.slice(0, -3)}y`;
  else if (w.endsWith('sses')) w = w.slice(0, -2);
  else if (w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is')) w = w.slice(0, -1);

  if (w.endsWith('ing') && w.length >= 6) w = w.slice(0, -3);
  else if (w.endsWith('ed') && w.length >= 5) w = w.slice(0, -2);

  // "stopp" from "stopped", "sett" from "settings".
  if (/([bdgmnprt])\1$/.test(w)) w = w.slice(0, -1);
  if (w.endsWith('e') && w.length > 3) w = w.slice(0, -1);
  return w;
}

/** Lowercase, accents folded, split on anything that is not a letter or digit. */
export function words(text: string): string[] {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** The ranking tokens of a text: words, minus stopwords and single letters, stemmed. */
export function tokenize(text: string): string[] {
  return words(text)
    .filter((w) => (w.length > 1 || /\d/.test(w)) && !STOPWORDS.has(w))
    .map(stem);
}

/**
 * Words a person asks with that the documentation spells differently.
 *
 * Written as plain words and stemmed once here. A question word also matches
 * its synonyms, at a lower weight, so "SSO" finds "single sign-on" and "seats"
 * finds team members, without the synonym counting as the documentation's
 * own word.
 */
const SYNONYM_WORDS: Record<string, string[]> = {
  sso: ['single', 'sign'],
  saml: ['single', 'sign'],
  oidc: ['single', 'sign'],
  // Identity providers the docs do not name: they lead to the SSO sections,
  // which say what is supported, and the model may say no more than that.
  okta: ['single', 'sign', 'saml', 'oidc'],
  entra: ['single', 'sign', 'saml', 'oidc'],
  onelogin: ['single', 'sign', 'saml', 'oidc'],
  jumpcloud: ['single', 'sign', 'saml', 'oidc'],
  vmc: ['certificate', 'mark', 'bimi'],
  cmc: ['certificate', 'mark', 'bimi'],
  create: ['issue', 'add'],
  make: ['create', 'add'],
  setup: ['set', 'add'],
  whitelabel: ['brand', 'logo', 'colours'],
  rebrand: ['brand', 'logo', 'colours'],
  branding: ['brand', 'logo', 'colours'],
  logo: ['brand'],
  color: ['colours'],
  colors: ['colours'],
  cost: ['price'],
  costs: ['price'],
  expensive: ['price'],
  cheap: ['price'],
  fee: ['price'],
  seat: ['members', 'team'],
  seats: ['members', 'team'],
  user: ['members'],
  users: ['members'],
  staff: ['members', 'team'],
  colleague: ['members', 'invite'],
  employee: ['members'],
  delete: ['erasure'],
  remove: ['delete', 'erasure'],
  erase: ['erasure', 'delete'],
  gdpr: ['privacy', 'personal'],
  backup: ['export'],
  download: ['export'],
  invoice: ['billing', 'payment'],
  pay: ['payment', 'billing'],
  subscription: ['plan', 'billing'],
  upgrade: ['plan'],
  downgrade: ['plan'],
  refund: ['money', 'guarantee'],
  ticket: ['psa'],
  tickets: ['psa'],
  mfa: ['two', 'step'],
  '2fa': ['two', 'step'],
  totp: ['two', 'step', 'authenticator'],
  phishing: ['spoofing'],
  impersonation: ['spoofing'],
  rua: ['aggregate', 'reporting'],
  ruf: ['forensic'],
  token: ['key'],
  quota: ['limit'],
  limits: ['limit'],
  enforce: ['reject', 'quarantine'],
  enforcement: ['reject', 'quarantine'],
  ownership: ['verification', 'prove'],
  verify: ['verification', 'prove'],
  sla: ['service', 'level'],
  uptime: ['service', 'level'],
  location: ['stored', 'region'],
  residency: ['stored', 'region'],
  retain: ['kept', 'keep'],
  retention: ['kept', 'keep'],
  mailbox: ['inbox'],
  imap: ['mailbox', 'inbox'],
  slack: ['alerts'],
  teams: ['alerts'],
  agency: ['workspace'],
  tenant: ['workspace'],
};

export const SYNONYMS: ReadonlyMap<string, string[]> = new Map(
  Object.entries(SYNONYM_WORDS).map(([word, alternatives]) => [
    stem(word),
    [...new Set(alternatives.map((w) => stem(w)))].filter((w) => w !== stem(word)),
  ]),
);

/** Phrases folded into one word before tokenizing, so they match as a unit. */
const PHRASES: Array<[RegExp, string]> = [
  [/\bwhite[\s-]?label(?:l?ed|l?ing)?\b/gi, ' whitelabel brand logo colours '],
  [/\bsingle[\s-]sign[\s-]on\b/gi, ' sso single sign '],
  [/\btwo[\s-](?:step|factor)\b/gi, ' two step verification mfa '],
  [/\bmoney[\s-]back\b/gi, ' refund money back '],
  [/\bcustom domains?\b/gi, ' custom domain own domain '],
  [/\bapi keys?\b/gi, ' api key '],
];

export function expandPhrases(text: string): string {
  let out = text;
  for (const [pattern, replacement] of PHRASES) out = out.replace(pattern, replacement);
  return out;
}
