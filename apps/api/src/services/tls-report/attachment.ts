import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';
import { ReportArchiveError } from '../report/report-archive.js';

/** Largest decompressed TLS report accepted. */
export const maxTlsReportBytes = 5 * 1024 * 1024;

const gunzipAsync = promisify(gunzip) as (
  buffer: Buffer,
  options: { maxOutputLength: number },
) => Promise<Buffer>;

function tooLarge(): ReportArchiveError {
  return new ReportArchiveError('The TLS report decompresses to more than 5 MB, so it was not read.');
}

/**
 * Decodes a TLS-RPT attachment. The bytes are sniffed rather than trusted from
 * the filename or MIME type, because reporters label the same gzip file in
 * several ways; anything that is not gzip or JSON is not a TLS report.
 */
export async function tlsReportJsonFromAttachment(content: Buffer): Promise<string> {
  let decoded: Buffer;
  if (content.length >= 2 && content[0] === 0x1f && content[1] === 0x8b) {
    try {
      decoded = await gunzipAsync(content, { maxOutputLength: maxTlsReportBytes });
    } catch (error) {
      if (error instanceof RangeError || (error as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') {
        throw tooLarge();
      }
      throw new ReportArchiveError('The compressed TLS report is damaged and could not be decompressed.');
    }
  } else {
    if (content.length > maxTlsReportBytes) {
      throw tooLarge();
    }
    decoded = content;
  }

  const text = decoded.toString('utf8').replace(/^\uFEFF/, '');
  if (!text.trimStart().startsWith('{')) {
    throw new ReportArchiveError('The attachment is not a TLS report.');
  }
  return text;
}
