/**
 * One CSV cell, quoted only when it has to be.
 *
 * A value that starts with =, +, -, @, tab or carriage return is prefixed with
 * a single quote. Spreadsheets run a cell like `=HYPERLINK(...)` as a formula,
 * and client names here are typed by the agency, so a file an MSP opens to
 * bill its clients must not be able to execute anything. Numbers are written
 * as numbers, so a negative count is not mistaken for a formula and mangled.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  const raw = value instanceof Date ? value.toISOString() : String(value);
  const text = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Rows to CSV text with CRLF line endings, which every spreadsheet reads. */
export function toCsv(header: readonly string[], rows: readonly (readonly unknown[])[]): string {
  return [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
