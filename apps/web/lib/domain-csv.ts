/**
 * domain-csv.ts — the domain names in a CSV file, for the Add domains list.
 *
 * The column headed `domain` (or `domain_name`, `domain name`, `name`,
 * `hostname`) when the first row names one; else the first column, with the
 * first row kept when it already looks like a domain. Quotes around a cell are
 * dropped. Nothing is judged here: every name joins the list and goes through
 * the same check as a paste, so a bad row is reported the same way.
 *
 * Pure, with no imports, so tests/domain-csv.test.ts covers it.
 */

const HEADERS = ["domain", "domain_name", "domain name", "domains", "name", "hostname"];

/** A cell that reads like a hostname rather than a column title. */
const LOOKS_LIKE_DOMAIN = /^[^\s,;]+\.[^\s,;]+$/;

export function domainsFromCsv(text: string): string[] {
  const rows = text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line) => line.split(/[,;\t]/).map((cell) => cell.trim().replace(/^"(.*)"$/, "$1").trim()))
    .filter((cells) => cells.some((c) => c !== ""));
  if (rows.length === 0) return [];
  const header = rows[0]!.map((c) => c.toLowerCase());
  const named = header.findIndex((c) => HEADERS.includes(c));
  const column = named >= 0 ? named : 0;
  const hasHeader = named >= 0 || !LOOKS_LIKE_DOMAIN.test(rows[0]![0] ?? "");
  return (hasHeader ? rows.slice(1) : rows).map((cells) => cells[column] ?? "").filter(Boolean);
}
