/**
 * The decisions taken about a question before any model sees it.
 *
 * Deterministic and local, so they are unit-tested and cost nothing:
 *
 *   input     empty, too long, or not a question at all (keyboard mash, one
 *             character repeated, the same word over and over).
 *   redact    email addresses, links, IP addresses, domain names and anything
 *             shaped like a key are replaced before the question is sent or
 *             stored. The assistant never needs them to answer from the docs,
 *             and it means a pasted client domain never leaves the workspace.
 *   scope     chit-chat, instructions aimed at the model, questions about
 *             other customers, lookups of this workspace's own data, legal
 *             advice and questions about other vendors are refused here.
 *
 * The model's own instruction to answer only from the excerpts is the second
 * line; these are the first.
 */

export type InputProblem = 'empty' | 'too_long' | 'garbage';

export type RefusalKind =
  | 'chit_chat'
  | 'instructions'
  | 'other_customer'
  | 'workspace_data'
  | 'action'
  | 'legal_advice'
  | 'other_vendor';

/** Trimmed, one line, control characters removed, Unicode composed. */
export function normaliseQuestion(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw
    .normalize('NFC')
    // Control and invisible formatting characters: the point is to match them.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function checkQuestion(
  text: string,
  maxChars: number,
): { ok: true } | { ok: false; problem: InputProblem; message: string } {
  if (text.length === 0) {
    return { ok: false, problem: 'empty', message: 'Type a question about the product first.' };
  }
  if (text.length > maxChars) {
    return {
      ok: false,
      problem: 'too_long',
      message: `A question can be at most ${maxChars} characters. Ask about one thing at a time.`,
    };
  }
  if (looksLikeGarbage(text)) {
    return {
      ok: false,
      problem: 'garbage',
      message: 'That does not read as a question. Ask in a sentence, for example "How do I add a domain?"',
    };
  }
  return { ok: true };
}

export function looksLikeGarbage(text: string): boolean {
  const letters = text.match(/\p{L}/gu)?.length ?? 0;
  const visible = text.replace(/\s/g, '').length;
  if (letters < 2) return true;
  if (visible > 0 && letters / visible < 0.5) return true;
  // One character six times running: "aaaaaa", "??????".
  if (/(.)\1{5,}/u.test(text)) return true;

  const tokens = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length >= 6 && new Set(tokens).size / tokens.length < 0.35) return true;

  // Keyboard mash: most longer words have no vowel at all.
  const longer = tokens.map((t) => t.replace(/[^\p{L}]/gu, '')).filter((t) => t.length >= 5);
  const voiceless = longer.filter((t) => !/[aeiouy\u00e0-\u00ff]/i.test(t));
  if (voiceless.length >= 2 && voiceless.length / longer.length > 0.6) return true;

  // One unbroken run of letters longer than any real word.
  if (tokens.length === 1 && /^\p{L}{25,}$/u.test(tokens[0]!)) return true;
  return false;
}

/** Extensions and suffixes that look like a domain's last label and are not. */
const NOT_A_TLD = new Set([
  'js', 'json', 'csv', 'pdf', 'xml', 'md', 'txt', 'html', 'htm', 'svg', 'png', 'jpg', 'jpeg', 'gif',
  'webp', 'zip', 'gz', 'ts', 'tsx', 'yml', 'yaml', 'toml', 'sh', 'ps1', 'py', 'eml', 'log', 'ini', 'cfg',
]);

/** Our own addresses are product facts, not workspace data. */
const KEEP_HOSTS = /(^|\.)dmarcharbor\.com$/i;

/**
 * Removes what could identify a workspace, a client or a person.
 *
 * The question is answered from public documentation, so none of this is ever
 * needed; replacing it before the model and the log see it is what lets the
 * sub-processor notice say nothing from a workspace is sent.
 */
export function redact(text: string): string {
  return text
    .replace(/\bhttps?:\/\/\S+/gi, '[link]')
    .replace(/[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}/gu, '[email]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?:\/\d{1,2})?\b/g, '[address]')
    .replace(/\b[0-9a-f]{1,4}(?::[0-9a-f]{0,4}){2,7}(?:\/\d{1,3})?/gi, '[address]')
    .replace(/\b(?:dmh_[A-Za-z0-9_]+|[A-Za-z0-9_-]{32,}|[A-Fa-f0-9]{24,})\b/g, '[secret]')
    .replace(/\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,24})\b/gi, (match: string, tld: string) => {
      if (NOT_A_TLD.has(tld.toLowerCase())) return match;
      if (KEEP_HOSTS.test(match)) return match;
      // "quarantine.Then" is a missing space, not a domain.
      if (/\.[A-Z][a-z]/.test(match)) return match;
      return '[domain]';
    });
}

/** What the answer cache keys on: case, punctuation and spacing do not make a new question. */
export function cacheKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s[\]]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * DMARC vendors other than this product. Real senders (Microsoft 365,
 * HubSpot, Mailchimp) are not here: the docs talk about them as senders.
 */
const OTHER_VENDORS =
  /\b(dmarcian|valimail|easydmarc|easy dmarc|red ?sift|ondmarc|powerdmarc|power dmarc|proofpoint|mimecast|agari|uriports|dmarcly|sendmarc|mxtoolbox|dmarc analyzer|dmarcadvisor|dmarc advisor|cloudmark|kdmarc|dmarc report|dmarcreport)\b/i;

const SCOPE_RULES: Array<[RefusalKind, RegExp]> = [
  [
    'instructions',
    /\b(ignore|disregard|forget)\b.{0,40}\b(instructions?|prompt|above|previous|everything)\b|\b(system prompt|developer (message|mode)|jailbreak|you are now|pretend (to be|you are)|roleplay|role-play|repeat (the|your) (text|prompt|instructions))\b/i,
  ],
  [
    'chit_chat',
    /^(hi|hello|hey|hiya|yo|thanks|thank you|thx|ta|cheers|good (morning|afternoon|evening)|how are you( doing)?|who are you|what are you|are you (a |an )?(bot|human|ai|robot|real( person)?)|what is your name|ok|okay|cool|nice|great|test|testing)\b[\s!.?]*$/i,
  ],
  [
    'chit_chat',
    /\b(tell me a joke|joke|poem|limerick|song lyrics|weather|recipe|horoscope|football|cricket|movie|bitcoin|crypto|lottery|meaning of life)\b|\bwrite (me )?(an? |the )?(essay|poem|story|song|letter|tweet|blog post|cover letter|python|javascript|script|program|code)\b/i,
  ],
  [
    'other_customer',
    /\b(who|which|what|list|name)\b.{0,30}\b(other|your) (customers|agencies|msps|tenants)\b|\bcustomer list\b|\bhow many (customers|agencies|msps|users|tenants) (do you|does it|are there|use)\b|\b(who else|anyone else)\b.{0,30}\b(uses?|using|monitors?)\b|\bwho (owns|monitors|added|registered)\b|\b(another|other) (customer|agency|msp|company)'s\b/i,
  ],
  [
    'workspace_data',
    /^(how many|list|show( me)?|count|which of)\b.{0,40}\b(my|our)\b|^how many\b.{0,40}\b(do|does|have|has|did) (i|we|this workspace)\b|\b(what|which) plan (am i|are we|is (this|my|our) workspace) on\b|\bwhat('s| is) (my|our) (current )?(plan|dmarc record|spf record|pass rate|bill|invoice|usage)\b/i,
  ],
  [
    'legal_advice',
    /\b(legal advice|lawyer|attorney|solicitor|sue|lawsuit|liable|liability for|am i (legally )?(required|obliged|allowed)|are we (legally )?(required|obliged|allowed)|is it (legal|lawful)|do (i|we) legally need|do (i|we) need (a|an) (dpa|contract|lawyer|consent|licen[cs]e)|do (i|we) need to sign|what (does|do) (the )?(law|gdpr|hipaa|ccpa) require)\b/i,
  ],
  [
    'action',
    /^(can|could|would|will) you (please )?(add|create|delete|remove|send|change|update|set|publish|invite|upgrade|downgrade|cancel|turn|enable|disable|fix|check|scan|run|reset|verify|move|approve|email)\b|^(please )?(add|create|delete|remove|send|publish|invite|upgrade|downgrade|cancel|enable|disable|fix|scan|run|reset|approve)\b.{0,40}\b(for me|my|our|this)\b/i,
  ],
  [
    'workspace_data',
    /^(can you |could you |please )?(summari[sz]e|analy[sz]e|look at|review|audit)\b.{0,20}\b(my|our|this)\b/i,
  ],
];

/** What vendor-related wording makes a question about the product rather than the vendor. */
const MOVING_FROM = /\b(move|moving|switch|switching|migrat\w*|import\w*|leav\w*|from|replace|replacing|both|alongside|existing)\b/i;
const COMPARING = /\b(better|worse|compare\w*|vs\.?|versus|cheaper|pricier|alternative\w*|difference|differ\w*|review\w*|rating)\b/i;

export function classifyScope(text: string): RefusalKind | null {
  for (const [kind, pattern] of SCOPE_RULES) {
    if (pattern.test(text)) return kind;
  }
  if (OTHER_VENDORS.test(text) && (COMPARING.test(text) || !MOVING_FROM.test(text))) return 'other_vendor';
  return null;
}

/** The sentence each refusal opens with. The support route is shown under every one. */
export const REFUSAL_MESSAGES: Record<RefusalKind, string> = {
  chit_chat: 'I only answer questions about using the product, from its own documentation.',
  instructions: 'I only answer questions about using the product, from its own documentation.',
  other_customer:
    'I cannot discuss other customers or their workspaces. Nothing about any workspace is available to me, this one included.',
  workspace_data:
    "I cannot see this workspace's data, so I cannot look up your own clients, domains, figures or plan. The product's own screens show them.",
  action:
    'I cannot do things in the product for you, and I cannot see this workspace. I can only say how it is done, from the documentation.',
  legal_advice:
    'I cannot give legal advice. The documents below say what the product commits to; for your own obligations, ask your legal adviser.',
  other_vendor: 'I can only answer about this product, not about other vendors or how they compare.',
};

/** Refusals worth showing documentation links under, when retrieval finds some. */
export const REFUSALS_WITH_LINKS: ReadonlySet<RefusalKind> = new Set(['workspace_data', 'action', 'legal_advice']);
