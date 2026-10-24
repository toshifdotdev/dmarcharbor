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
export const maxZipEntries = 20;

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

async function inflateBounded(inflate: typeof gunzipAsync, data: Buffer): Promise<Buffer> {
  try {
    return await inflate(data, { maxOutputLength: maxReportXmlBytes });
  } catch (error) {
    if (error instanceof RangeError || (error as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') {
      throw tooLarge();
    }
    throw new ReportArchiveError('The compressed report is damaged and could not be decompressed.');
  }
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

async function readZipEntry(zip: Buffer, entry: ZipEntry): Promise<Buffer> {
  if (entry.flags & 0x1) {
    throw new ReportArchiveError(`The ZIP entry ${entry.name} is encrypted, so it cannot be read.`);
  }
  if (entry.compressedSize === ZIP64_MARKER || entry.uncompressedSize === ZIP64_MARKER) {
    throw new ReportArchiveError('The ZIP attachment uses the ZIP64 format, which no DMARC report needs, so it was not read.');
  }
  if (entry.uncompressedSize > maxReportXmlBytes) {
    throw tooLarge();
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
  } else if (entry.method === 8) {
    content = await inflateBounded(inflateRawAsync, data);
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

async function unzipReports(zip: Buffer): Promise<string[]> {
  const files = readCentralDirectory(zip).filter((entry) => !entry.name.endsWith('/'));
  // Prefer the XML files; a ZIP holding one file of another name is still read,
  // because some generators name the entry without an extension.
  const xmlFiles = files.filter((entry) => entry.name.toLowerCase().endsWith('.xml'));
  const chosen = xmlFiles.length > 0 ? xmlFiles : files.length === 1 ? files : [];
  if (chosen.length === 0) {
    throw new ReportArchiveError('The ZIP attachment contains no XML report.');
  }

  const reports: string[] = [];
  for (const entry of chosen.slice(0, maxZipEntries)) {
    reports.push((await readZipEntry(zip, entry)).toString('utf8'));
  }
  return reports;
}

/**
 * The XML report(s) inside one attachment. A ZIP can carry more than one; gzip
 * and plain XML carry one. Throws ReportArchiveError with a sentence that says
 * why when the attachment cannot be read.
 */
export async function reportXmlFromAttachment(content: Buffer): Promise<string[]> {
  if (content.length > maxReportXmlBytes) {
    throw tooLarge();
  }

  const kind = sniffArchive(content);
  if (kind === 'gzip') {
    const inflated = await inflateBounded(gunzipAsync, content);
    // Some generators zip and then gzip; one level of nesting is read.
    return sniffArchive(inflated) === 'zip' ? unzipReports(inflated) : [inflated.toString('utf8')];
  }
  if (kind === 'zip') {
    return unzipReports(content);
  }
  if (kind === 'xml') {
    return [content.toString('utf8')];
  }
  throw new ReportArchiveError('The attachment is not XML, gzip or ZIP.');
}
