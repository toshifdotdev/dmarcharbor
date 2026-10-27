import type { BimiSvgChecks } from './transport-records.js';

/**
 * The seven SVG Tiny PS checks, in plain words.
 *
 * These are the labels the domain page already shows for a scanned logo
 * (apps/web/components/harbor/scan-history.tsx), moved here so the upload
 * refusal and the scanner's finding name a failed check the same way. The
 * labels are a list rather than a sentence on purpose: an upload error that
 * says "the SVG is invalid" leaves the person guessing which of seven rules
 * they broke, and the file is the one thing they can fix.
 *
 * Kept as an ordered array so the order is stable in a response and in a test.
 */
export const bimiSvgCheckLabels: Array<[keyof BimiSvgChecks, string]> = [
  ['svgRoot', 'First element is svg'],
  ['tinyPsProfile', 'baseProfile="tiny-ps"'],
  ['version12', 'version="1.2"'],
  ['title', 'Non-empty title'],
  ['noForbiddenElements', 'No forbidden elements or event attributes'],
  ['noExternalReferences', 'No external references'],
  ['withinSizeLimit', 'Within 32,768 bytes'],
];

/** The labels of every check this document failed, in label order. */
export function failedBimiChecks(checks: BimiSvgChecks): string[] {
  return bimiSvgCheckLabels.filter(([key]) => !checks[key]).map(([, label]) => label);
}

/**
 * XML constructs that are refused on top of the seven checks.
 *
 * `inspectBimiSvg` reads the document as text, so a DOCTYPE with an internal
 * subset can define entities that expand into something the text scan never
 * saw. Nothing in a Tiny PS logo needs either, and a certificate authority
 * would not have approved a file containing them.
 */
export function hasXmlEntityTricks(text: string): boolean {
  return /<!DOCTYPE/i.test(text) || /<!ENTITY/i.test(text);
}

/**
 * True when the bytes are valid UTF-8 with no replacement characters.
 *
 * `Buffer.toString('utf8')` silently substitutes U+FFFD for invalid
 * sequences, so a file that is not UTF-8 would pass every textual check and be
 * served as `image/svg+xml` with bytes no parser agrees on. Decoding and
 * re-encoding is the round trip that catches it.
 */
export function isValidUtf8(bytes: Buffer): boolean {
  const decoded = bytes.toString('utf8');
  if (decoded.includes('\uFFFD')) {
    return false;
  }
  return Buffer.from(decoded, 'utf8').equals(bytes);
}
