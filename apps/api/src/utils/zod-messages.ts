import type { ZodIssue } from 'zod';

/**
 * zod-messages.ts — what a rejected field should say.
 *
 * Ten controllers answered a validation failure with
 * `body.error.issues[0]?.message`, which is Zod's own text: "String must
 * contain at least 3 character(s)", "Array must contain at least 1 element(s)".
 * Those are generator phrases, not sentences a person can act on, and they
 * arrive as the API's `error.message`, which the UI shows verbatim.
 *
 * The mapping is deliberately coarse. It names the field and says what is wrong
 * with it in plain words, and it stops there — inventing per-field copy for
 * eighty fields would be a second schema to keep in sync with the first, and the
 * schema is the thing that already defines what is valid.
 *
 * The `path` is what makes these usable: "Name must be at least 3 characters"
 * versus a sentence that never says which field failed.
 */

/** Zod's own English, kept only as a last resort when nothing matches. */
function fallback(issue: ZodIssue): string {
  return issue.message || 'That value is not valid.';
}

/**
 * Zod's string refinements (`.startsWith`, `.endsWith`, `.includes`,
 * `.regex`) all emit a message beginning with this. They are as much generator
 * text as the `too_small` codes are — "Invalid input: must start with
 * "https://"" reached an operator verbatim — and they are restated rather than
 * forwarded.
 *
 * The test for Zod's own phrasing is that prefix. A hand-written refinement
 * message from `superRefine` does not carry it, which is how the SSO
 * controller's author-written sentence still reaches the administrator.
 */
const ZOD_BOILERPLATE = /^Invalid input:/;

/** True when this issue's message is Zod's, not an author's. */
function isZodOwnMessage(issue: ZodIssue): boolean {
  return ZOD_BOILERPLATE.test(issue.message ?? '');
}

/**
 * The constraint, in words, keyed by the Zod code.
 *
 * `path` is joined with a dot because nested objects are common here
 * (`contact.email`), and saying "Email must be an email address" is better than
 * naming the whole path and leaving the operator to find it.
 */
function describeFor(issue: ZodIssue): string {
  const field = issue.path.length > 0 ? humanField(issue.path) : 'This field';

  switch (issue.code) {
    case 'too_small':
      if (issue.origin === 'string') {
        return `${field} must be at least ${issue.minimum} characters.`;
      }
      if (issue.origin === 'array') {
        // "must have" rather than "needs": the field name is plural in the
        // common case (scopes, domains, events), and "Scopes needs at least 1
        // item" read as a typo. "must have" carries no number agreement.
        return `${field} must have at least ${issue.minimum} item${Number(issue.minimum) === 1 ? '' : 's'}.`;
      }
      if (issue.origin === 'number') {
        return `${field} must be at least ${issue.minimum}.`;
      }
      return `${field} is too short.`;

    case 'too_big':
      if (issue.origin === 'string') {
        return `${field} must be at most ${issue.maximum} characters.`;
      }
      if (issue.origin === 'array') {
        return `${field} can have at most ${issue.maximum} item${Number(issue.maximum) === 1 ? '' : 's'}.`;
      }
      if (issue.origin === 'number') {
        return `${field} must be at most ${issue.maximum}.`;
      }
      return `${field} is too long.`;

    case 'invalid_type':
      // Zod 4 reports an infinite number here too (Zod 3 had `not_finite`).
      // `received` is set at runtime but is not in Zod 4's issue type.
      if (issue.expected === 'number' && /received -?Infinity$/.test(issue.message)) {
        return `${field} must be a number.`;
      }
      return `${field} is required.`;

    case 'invalid_format':
      // Zod 4 folds `.email()`, `.url()`, `.regex()`, `.startsWith()` and the
      // other string checks into this one code (Zod 3's `invalid_string`).
      if (issue.format === 'email') {
        return `${field} must be an email address.`;
      }
      if (issue.format === 'url') {
        return `${field} must be a URL starting with https.`;
      }
      return `${field} is not in the right format.`;

    case 'invalid_value':
      // Zod 4 uses this one code for both enums and literals.
      if (issue.values.length === 1) {
        return `${field} must be exactly ${String(issue.values[0])}.`;
      }
      return `${field} is not one of the allowed values: ${issue.values.map(String).join(', ')}.`;

    case 'unrecognized_keys':
      return `${field} is not a field this endpoint accepts.`;

    case 'invalid_union':
      return `${field} is not in a recognised format.`;

    case 'not_multiple_of':
      return `${field} must be a multiple of ${issue.divisor}.`;

    case 'custom':
      // A refinement's own sentence when the author wrote one; Zod's boilerplate
      // when a `.startsWith`/`.regex` refinement produced it.
      return isZodOwnMessage(issue) ? fallback(issue) : issue.message || fallback(issue);

    default:
      return fallback(issue);
  }
}

/**
 * The field name, as a phrase: `contact.email` becomes `Email`,
 * `expiresInDays` becomes `Expires in days`.
 *
 * Only the FIRST word is capitalised. Capitalising all of them produced
 * "Expires In Days must be at least 1.", which reads like a headline rather than
 * the middle of a sentence — the message continues with "must be…", so the field
 * name is the start of it and takes sentence case.
 *
 * The last path segment is used, because the operator is looking at one input,
 * not at the object it lives in.
 */
function humanField(path: PropertyKey[]): string {
  const raw = String(path[path.length - 1] ?? 'this field');
  // Split camelCase/PascalCase into words, and split on underscores too.
  const words = raw
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[\s_]+/)
    .filter(Boolean);

  if (words.length === 0) return 'This field';
  return words[0]![0]!.toUpperCase() + words[0]!.slice(1) + words.slice(1).map((w) => ' ' + w).join('');
}

/**
 * The message for the first issue.
 *
 * First, not all of them: the API returns one message and a form highlights one
 * field. Listing every problem in a single line is how you get
 * "Name: required. Email: required." which reads as broken.
 */
export function zodMessage(issues: readonly ZodIssue[] | undefined): string {
  const first = issues?.[0];
  if (!first) return 'That request is not valid.';

  const described = describeFor(first);
  return described.length > 0 ? described : fallback(first);
}
