/**
 * instant.ts — the one place a stored timestamp becomes a sentence.
 *
 * WHY IT EXISTS, AND WHY IT LIVES HERE
 *
 * A timestamp formatted during render is a hydration risk, not a style choice.
 * A server component renders "07 Oct 2026, 14:22" into the HTML, the browser
 * re-renders the same value during hydration, and the two disagree whenever the
 * runtime locale or time zone differs from the server's. React reports that as a
 * mismatch on every affected row and throws away the server's markup.
 *
 * The fix in this codebase is to format on the server and hand the finished
 * string down, which is what audit-display.ts does for the trail. This module is
 * the same rule for the forensic and scan screens: a row that renders on first
 * paint carries a string, never a raw timestamp.
 *
 * It stays usable from a client component for one reason: a value fetched after
 * an interaction (a single forensic report, one scan) is formatted in the
 * browser, and by then there is no server markup to disagree with.
 *
 * The format is fixed to en-GB because the audit trail already is, so two
 * screens read as one product.
 */

/**
 * A stored timestamp, in words a reader can quote, or an explicit statement that
 * it was not recorded.
 *
 * "not recorded" is returned rather than an empty string on purpose. A missing
 * time is a gap in the record, and a blank cell reads as "nothing to see here"
 * instead of "we do not know when this happened".
 */
export function instantLabel(value: string | null | undefined): string {
  if (!value) return "not recorded";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "not recorded";
  return parsed.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** The same instant to the second, for the row that has to be cited exactly. */
export function instantLabelPrecise(value: string | null | undefined): string {
  if (!value) return "not recorded";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "not recorded";
  return parsed.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}