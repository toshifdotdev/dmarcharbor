import { env } from '../../config/env.js';
import { isOurAddress, normaliseReportUri } from '../report-address.service.js';

export interface SwitchWarning {
  code: string;
  message: string;
}

export interface DmarcRecordSegment {
  /** The tag exactly as written, including whitespace and the trailing value. */
  raw: string;
  /** The lowercased tag name, or '' for an empty segment. */
  key: string;
  /** The trimmed value. */
  value: string;
}

/**
 * Splits a record into tags without normalising anything.
 *
 * Every rewrite below starts and ends with these raw segments, so a tag nobody
 * asked to change keeps its whitespace, its key spelling and its value. A DMARC
 * switch that re-serialised the record could quietly rewrite a policy tag, and
 * that would change enforcement.
 */
export function splitDmarcRecord(record: string): DmarcRecordSegment[] {
  return record.split(';').map((raw) => {
    const separator = raw.indexOf('=');
    if (separator < 0) {
      return { raw, key: raw.trim().toLowerCase(), value: '' };
    }
    return {
      raw,
      key: raw.slice(0, separator).trim().toLowerCase(),
      value: raw.slice(separator + 1).trim(),
    };
  });
}

/** The URIs in a rua/ruf value, each exactly as written. */
export function readRuaUris(value: string): string[] {
  return value.split(',').filter((uri) => uri.trim().length > 0);
}

function withValue(raw: string, value: string): string {
  const separator = raw.indexOf('=');
  if (separator < 0) {
    return `${raw}=${value}`;
  }
  const prefix = raw.slice(0, separator + 1);
  const rest = raw.slice(separator + 1);
  const leading = rest.match(/^\s*/)?.[0] ?? '';
  const trailing = rest.match(/\s*$/)?.[0] ?? '';
  return `${prefix}${leading}${value}${trailing}`;
}

function appendSegment(segments: DmarcRecordSegment[], raw: string): void {
  // A record ending in ';' leaves an empty last segment. Inserting before it
  // keeps the trailing semicolon where the author put it.
  const last = segments[segments.length - 1];
  if (last && last.raw === '' && last.key === '') {
    segments.splice(segments.length - 1, 0, splitDmarcRecord(raw)[0]!);
    return;
  }
  segments.push(splitDmarcRecord(raw)[0]!);
}

function joinSegments(segments: DmarcRecordSegment[]): string {
  return segments.map((segment) => segment.raw).join(';');
}

/**
 * Generates the dual record: ours first, every other tag untouched.
 *
 * Ours goes first because RFC 9990 section 3.5 has receivers evaluate URIs in
 * order, and some stop after the first two. Removing our other addresses keeps
 * us from receiving the same report twice from one receiver.
 */
export function buildDualRecord(record: string, ourAddress: string): { value: string; warnings: SwitchWarning[] } {
  const segments = splitDmarcRecord(record);
  const warnings: SwitchWarning[] = [];
  let sawRua = false;
  let firstRuaHandled = false;

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    if (segment.key !== 'rua') {
      continue;
    }

    sawRua = true;
    const uris = readRuaUris(segment.value);
    const kept = uris.filter((uri) => !isOurAddress(uri));

    if (!firstRuaHandled) {
      segment.raw = withValue(segment.raw, [`mailto:${ourAddress}`, ...kept].join(','));
      segment.value = segment.raw.slice(segment.raw.indexOf('=') + 1).trim();
      firstRuaHandled = true;
    } else if (kept.length === 0) {
      segments.splice(index, 1);
      index -= 1;
    } else {
      segment.raw = withValue(segment.raw, kept.join(','));
      segment.value = segment.raw.slice(segment.raw.indexOf('=') + 1).trim();
    }
  }

  if (!sawRua) {
    appendSegment(segments, ` rua=mailto:${ourAddress}`);
  }

  const ruaUris = segments
    .filter((segment) => segment.key === 'rua')
    .flatMap((segment) => readRuaUris(segment.value));

  if (ruaUris.length > 2) {
    const displaced = ruaUris.slice(2).map((uri) => uri.trim());
    warnings.push({
      code: 'third_address',
      message: `The record now has ${ruaUris.length} rua addresses. Some receivers only serve the first two, so reports may not reach ${displaced.join(', ')}.`,
    });
  }

  const pct = segments.find((segment) => segment.key === 'pct');
  if (pct) {
    warnings.push({
      code: 'pct_present',
      message: `pct=${pct.value} was kept unchanged. RFC 9989 retired pct, so receivers that follow it ignore the tag.`,
    });
  }

  warnings.push({
    code: 'no_policy_change',
    message: 'The policy tags were kept exactly as published, so this record does not change enforcement.',
  });

  return { value: joinSegments(segments), warnings };
}

/**
 * Generates the cutover record: the incumbent's addresses removed.
 *
 * A forensic address that belonged to the incumbent is removed from ruf as
 * well. If that empties ruf the tag goes with it, because `ruf=` with no value
 * is not a request for nothing, it is a broken record.
 */
export function buildCutoverRecord(
  record: string,
  incumbentUris: string[],
  ourAddress: string = env.REPORT_AGGREGATE_ADDRESS,
): { value: string; warnings: SwitchWarning[] } {
  const normalisedIncumbents = new Set(
    incumbentUris
      .map((uri) => normaliseReportUri(uri))
      .filter((uri): uri is string => uri !== null),
  );
  const lowercaseIncumbents = new Set(incumbentUris.map((uri) => uri.trim().toLowerCase()));

  const isIncumbent = (uri: string): boolean => {
    const normalised = normaliseReportUri(uri);
    if (normalised && normalisedIncumbents.has(normalised)) {
      return true;
    }
    // https rua targets are not mail addresses, so they are compared exactly.
    return lowercaseIncumbents.has(uri.trim().toLowerCase());
  };

  const segments = splitDmarcRecord(record);
  let forensicRemoved = false;
  let ruaTagSeen = false;
  let ruaRetained = false;

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    if (segment.key !== 'rua' && segment.key !== 'ruf') {
      continue;
    }

    const uris = readRuaUris(segment.value);
    const kept = uris.filter((uri) => !isIncumbent(uri));
    const removed = kept.length !== uris.length;

    if (segment.key === 'rua') {
      ruaTagSeen = true;
    }
    if (segment.key === 'ruf' && removed) {
      forensicRemoved = true;
    }

    if (removed) {
      if (kept.length === 0) {
        if (segment.key === 'rua' && !ruaRetained) {
          segment.raw = withValue(segment.raw, `mailto:${ourAddress}`);
          segment.value = `mailto:${ourAddress}`;
          ruaRetained = true;
          continue;
        }
        segments.splice(index, 1);
        index -= 1;
        continue;
      }
      segment.raw = withValue(segment.raw, kept.join(','));
      segment.value = segment.raw.slice(segment.raw.indexOf('=') + 1).trim();
    }

    if (segment.key === 'rua') {
      ruaRetained = true;
    }
  }

  // The record had a rua and every address in it was the incumbent's. Ours is
  // the only safe replacement: dropping the tag would silently stop all
  // reporting at cutover, which is the failure this whole workflow avoids.
  if (ruaTagSeen && !ruaRetained) {
    appendSegment(segments, ` rua=mailto:${ourAddress}`);
  }

  const warnings: SwitchWarning[] = [];
  if (forensicRemoved) {
    warnings.push({
      code: 'forensic_removed',
      message:
        'The forensic report address was removed. Forensic reports now go nowhere until forensic collection is enabled with DMARC Harbor.',
    });
  }

  return { value: joinSegments(segments), warnings };
}
