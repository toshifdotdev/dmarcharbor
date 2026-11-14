import { crc32, gunzip, inflateRaw } from 'node:zlib';
import { promisify } from 'node:util';

/**
 * Turning a report attachment into XML: plain, gzip or ZIP.
 *
 * RFC 9990 (section 3.5.2) asks report generators for gzip, but receivers that
 * predate it still send ZIP, and this used to accept only .xml and .xml.gz, so
 * a ZIP report was skipped without a trace. The content is sniffed by its magic
 * bytes rather than trusted from the filename or MIME type, because senders
 * label reports inconsistently (application/octet-stream is common).
 *
 * Decompression is bounded: a report is a few megabytes at most, and an
 * attachment that inflates past the limit is refused rather than allowed to
 * exhaust memory (a "zip bomb" is a few kilobytes that inflates to gigabytes).
 */

const gunzipAsync = promisify(gunzip) as (buffer: Buffer, options: { maxOutputLength: number }) => Promise<Buffer>;
const inflateRawAsync = promisify(inflateRaw) as (buffer: Buffer, options: { maxOutputLength: number }) => Promise<Buffer>;

/** Largest uncompressed report accepted, per report. */
export const maxReportXmlBytes = 32 * 1024 * 1024;

/** Most report files read from one ZIP. A real report ZIP holds one. */
export const maxZipEntries = 10;

/**
 * The most decompressed bytes one email may produce, across all its
 * attachments and every file inside them.
 *
 * The per-report cap bounded one output only. Twenty attachments of twenty ZIP
 * entries each, all pointing at one shared 32 KB deflate stream, came to
 * 12.8 GB of strings from a mail of a few kilobytes, held in memory at once.
 */
export const maxDecodedBytesPerEmail = 64 * 1024 * 1024;

/** Decompressed bytes still allowed for the email being read. */
export interface DecodeBudget {
  remaining: number;
}

export function newDecodeBudget(): DecodeBudget {
  return { remaining: maxDecodedBytesPerEmail };
}

function budgetExhausted(): ReportArchiveError {
  return new ReportArchiveError(
    `This message decompresses to more than ${Math.round(maxDecodedBytesPerEmail / (1024 * 1024))} MB in total, so the rest of it was not read.`,
  );
}

/** Takes `bytes` from the budget, or refuses. */
export function spendBudget(budget: DecodeBudget | undefined, bytes: number): void {
  if (!budget) {
    return;
  }
  if (bytes > budget.remaining) {
    budget.remaining = 0;
    throw budgetExhausted();
  }
  budget.remaining -= bytes;
}

export class ReportArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReportArchiveError';
  }
}

export type ArchiveKind = 'gzip' | 'zip' | 'xml' | 'unknown';

/** What the bytes are, from their first bytes alone. */
export function sniffArchive(content: Buffer): ArchiveKind {
  if (content.length >= 2 && content[0] === 0x1f && content[1] === 0x8b) {
    return 'gzip';
  }
  if (content.length >= 4 && content.readUInt32LE(0) === 0x04034b50) {
    return 'zip';
  }
  const head = content.subarray(0, 512).toString('utf8').replace(/^\uFEFF/, '').trimStart();
  if (head.startsWith('<')) {
    return 'xml';
  }
  return 'unknown';
}

/**
 * Whether an email attachment is worth decoding as a report.
 *
 * Named or typed as XML, gzip or ZIP, or (for the senders that label
 * everything application/octet-stream) recognisable from its bytes.
 */
export function looksLikeReportAttachment(filename: string | undefined, contentType: string | undefined, content: Buffer): boolean {
  const name = filename?.toLowerCase() ?? '';
  const type = contentType?.toLowerCase() ?? '';
  if (/\.(xml|xml\.gz|gz|zip)$/.test(name)) {
    return true;
  }
  if (type.includes('xml') || type.includes('gzip') || type.includes('zip') || type.includes('compressed')) {
    return true;
  }
  const kind = sniffArchive(content);
  return kind === 'gzip' || kind === 'zip';
}

function tooLarge(): ReportArchiveError {
  return new ReportArchiveError(
    `The report decompresses to more than ${Math.round(maxReportXmlBytes / (1024 * 1024))} MB, so it was not read.`,
  );
}

async function inflateBounded(inflate: typeof gunzipAsync, data: Buffer, budget?: DecodeBudget): Promise<Buffer> {
  // Never more than one report's worth, nor more than the email has left.
  const limit = Math.max(1, Math.min(maxReportXmlBytes, budget ? budget.remaining : maxReportXmlBytes));
  let inflated: Buffer;
  try {
    inflated = await inflate(data, { maxOutputLength: limit });
  } catch (error) {
    if (error instanceof RangeError || (error as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') {
      throw budget && budget.remaining < maxReportXmlBytes ? budgetExhausted() : tooLarge();
    }
    throw new ReportArchiveError('The compressed report is damaged and could not be decompressed.');
  }
  spendBudget(budget, inflated.length);
  return inflated;
}

interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const ZIP64_MARKER = 0xffffffff;

function findEndOfCentralDirectory(zip: Buffer): number {
  // The record is 22 bytes plus a comment of up to 65535 bytes, at the very end.
  const lowest = Math.max(0, zip.length - 22 - 0xffff);
  for (let offset = zip.length - 22; offset >= lowest; offset--) {
    if (zip.readUInt32LE(offset) === EOCD_SIGNATURE) {
      return offset;
    }
  }
  throw new ReportArchiveError('The ZIP attachment is incomplete: its directory is missing.');
}

function readCentralDirectory(zip: Buffer): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(zip);
  const entryCount = zip.readUInt16LE(eocd + 10);
  const directoryOffset = zip.readUInt32LE(eocd + 16);
  if (directoryOffset === ZIP64_MARKER || entryCount === 0xffff) {
    throw new ReportArchiveError('The ZIP attachment uses the ZIP64 format, which no DMARC report needs, so it was not read.');
  }

  const entries: ZipEntry[] = [];
  let offset = directoryOffset;
  for (let index = 0; index < entryCount; index++) {
    if (offset + 46 > zip.length || zip.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      throw new ReportArchiveError('The ZIP attachment is damaged: its directory could not be read.');
    }
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    entries.push({
      flags: zip.readUInt16LE(offset + 8),
      method: zip.readUInt16LE(offset + 10),
      crc: zip.readUInt32LE(offset + 16),
      compressedSize: zip.readUInt32LE(offset + 20),
      uncompressedSize: zip.readUInt32LE(offset + 24),
      localHeaderOffset: zip.readUInt32LE(offset + 42),
      name: zip.subarray(offset + 46, offset + 46 + nameLength).toString('utf8'),
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function readZipEntry(zip: Buffer, entry: ZipEntry, budget?: DecodeBudget): Promise<Buffer> {
  if (entry.flags & 0x1) {
    throw new ReportArchiveError(`The ZIP entry ${entry.name} is encrypted, so it cannot be read.`);
  }
  if (entry.compressedSize === ZIP64_MARKER || entry.uncompressedSize === ZIP64_MARKER) {
    throw new ReportArchiveError('The ZIP attachment uses the ZIP64 format, which no DMARC report needs, so it was not read.');
  }
  if (entry.uncompressedSize > maxReportXmlBytes) {
    throw tooLarge();
  }
  if (budget && entry.uncompressedSize > budget.remaining) {
    throw budgetExhausted();
  }

  const local = entry.localHeaderOffset;
  if (local + 30 > zip.length || zip.readUInt32LE(local) !== LOCAL_SIGNATURE) {
    throw new ReportArchiveError(`The ZIP entry ${entry.name} is damaged.`);
  }
  const dataStart = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > zip.length) {
    throw new ReportArchiveError(`The ZIP entry ${entry.name} is truncated.`);
  }
  const data = zip.subarray(dataStart, dataEnd);

  let content: Buffer;
  if (entry.method === 0) {
    content = Buffer.from(data);
    spendBudget(budget, content.length);
  } else if (entry.method === 8) {
    content = await inflateBounded(inflateRawAsync, data, budget);
  } else {
    throw new ReportArchiveError(`The ZIP entry ${entry.name} uses a compression method (${entry.method}) other than deflate.`);
  }

  // The directory's sizes and checksum are checked rather than trusted: a
  // mismatch means the attachment was damaged in transit, and a damaged report
  // must not be counted as if it were whole.
  if (content.length !== entry.uncompressedSize || crc32(content) >>> 0 !== entry.crc >>> 0) {
    throw new ReportArchiveError(`The ZIP entry ${entry.name} failed its integrity check.`);
  }
  return content;
}

/**
 * Refuses a ZIP whose entries share or overrun their data.
 *
 * A real archive stores each file once, one after another. Entries whose
 * directory records point into the same bytes are the classic way to make a
 * small archive inflate many times over (one stream, read by every entry),
 * and the per-entry checks cannot see it because each entry is valid alone.
 */
function assertDisjointEntries(zip: Buffer, entries: ZipEntry[]): void {
  let total = 0;
  let previousEnd = 0;
  for (const entry of [...entries].sort((a, b) => a.localHeaderOffset - b.localHeaderOffset)) {
    total += entry.compressedSize;
    if (entry.localHeaderOffset < previousEnd || total > zip.length) {
      throw new ReportArchiveError('The ZIP attachment is malformed: its entries overlap, so it was not read.');
    }
    const local = entry.localHeaderOffset;
    if (local + 30 > zip.length) {
      throw new ReportArchiveError(`The ZIP entry ${entry.name} is damaged.`);
    }
    previousEnd = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28) + entry.compressedSize;
  }
}

async function unzipReports(zip: Buffer, budget?: DecodeBudget): Promise<string[]> {
  const entries = readCentralDirectory(zip);
  assertDisjointEntries(zip, entries);
  const files = entries.filter((entry) => !entry.name.endsWith('/'));
  // Prefer the XML files; a ZIP holding one file of another name is still read,
  // because some generators name the entry without an extension.
  const xmlFiles = files.filter((entry) => entry.name.toLowerCase().endsWith('.xml'));
  const chosen = xmlFiles.length > 0 ? xmlFiles : files.length === 1 ? files : [];
  if (chosen.length === 0) {
    throw new ReportArchiveError('The ZIP attachment contains no XML report.');
  }

  const reports: string[] = [];
  for (const entry of chosen.slice(0, maxZipEntries)) {
    reports.push((await readZipEntry(zip, entry, budget)).toString('utf8'));
  }
  return reports;
}

/**
 * The XML report(s) inside one attachment. A ZIP can carry more than one; gzip
 * and plain XML carry one. Throws ReportArchiveError with a sentence that says
 * why when the attachment cannot be read.
 */
export async function reportXmlFromAttachment(content: Buffer, budget?: DecodeBudget): Promise<string[]> {
  if (content.length > maxReportXmlBytes) {
    throw tooLarge();
  }

  const kind = sniffArchive(content);
  if (kind === 'gzip') {
    const inflated = await inflateBounded(gunzipAsync, content, budget);
    // Some generators zip and then gzip; one level of nesting is read.
    return sniffArchive(inflated) === 'zip' ? unzipReports(inflated, budget) : [inflated.toString('utf8')];
  }
  if (kind === 'zip') {
    return unzipReports(content, budget);
  }
  if (kind === 'xml') {
    spendBudget(budget, content.length);
    return [content.toString('utf8')];
  }
  throw new ReportArchiveError('The attachment is not XML, gzip or ZIP.');
}
