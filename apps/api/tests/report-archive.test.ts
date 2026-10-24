import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  looksLikeReportAttachment,
  maxReportXmlBytes,
  ReportArchiveError,
  reportXmlFromAttachment,
  sniffArchive,
} from '../src/services/report/report-archive.js';
import { buildZip } from './helpers/zip.js';

const XML = '<?xml version="1.0"?><feedback><report_metadata><report_id>r1</report_id></report_metadata></feedback>';

describe('sniffing an attachment by its bytes', () => {
  it('tells gzip, ZIP and XML apart without trusting the name', () => {
    expect(sniffArchive(gzipSync(XML))).toBe('gzip');
    expect(sniffArchive(buildZip([{ name: 'r.xml', content: XML }]))).toBe('zip');
    expect(sniffArchive(Buffer.from(XML))).toBe('xml');
    expect(sniffArchive(Buffer.from('\uFEFF  <feedback/>'))).toBe('xml');
    expect(sniffArchive(Buffer.from('%PDF-1.7'))).toBe('unknown');
  });

  it('accepts a report labelled application/octet-stream with no useful name', () => {
    const zip = buildZip([{ name: 'r.xml', content: XML }]);
    expect(looksLikeReportAttachment('attachment', 'application/octet-stream', zip)).toBe(true);
    expect(looksLikeReportAttachment('logo.png', 'image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe(false);
  });

  it('accepts the names and types receivers actually use', () => {
    const anything = Buffer.from('x');
    expect(looksLikeReportAttachment('google.com!example.com!1!2.zip', undefined, anything)).toBe(true);
    expect(looksLikeReportAttachment('x!example.com!1!2.xml.gz', undefined, anything)).toBe(true);
    expect(looksLikeReportAttachment(undefined, 'application/zip', anything)).toBe(true);
    expect(looksLikeReportAttachment(undefined, 'application/x-zip-compressed', anything)).toBe(true);
  });
});

describe('reading a report out of an attachment', () => {
  it('reads plain XML', async () => {
    expect(await reportXmlFromAttachment(Buffer.from(XML))).toEqual([XML]);
  });

  it('reads gzip', async () => {
    expect(await reportXmlFromAttachment(gzipSync(XML))).toEqual([XML]);
  });

  it('reads a deflated ZIP entry', async () => {
    expect(await reportXmlFromAttachment(buildZip([{ name: 'google.com!example.com!1!2.xml', content: XML }]))).toEqual([XML]);
  });

  it('reads a stored (uncompressed) ZIP entry', async () => {
    expect(await reportXmlFromAttachment(buildZip([{ name: 'r.xml', content: XML, method: 0 }]))).toEqual([XML]);
  });

  it('reads every XML report in a ZIP and ignores directories and other files', async () => {
    const second = XML.replace('r1', 'r2');
    const zip = buildZip([
      { name: 'reports/', content: '', method: 0 },
      { name: 'reports/a.xml', content: XML },
      { name: 'reports/readme.txt', content: 'not a report' },
      { name: 'reports/b.xml', content: second },
    ]);
    expect(await reportXmlFromAttachment(zip)).toEqual([XML, second]);
  });

  it('reads a single entry that has no .xml extension', async () => {
    expect(await reportXmlFromAttachment(buildZip([{ name: 'report', content: XML }]))).toEqual([XML]);
  });

  it('reads a ZIP that was gzipped again', async () => {
    expect(await reportXmlFromAttachment(gzipSync(buildZip([{ name: 'r.xml', content: XML }])))).toEqual([XML]);
  });

  it('refuses a damaged ZIP entry instead of counting a partial report', async () => {
    const zip = buildZip([{ name: 'r.xml', content: XML, crcOverride: 12345 }]);
    await expect(reportXmlFromAttachment(zip)).rejects.toThrow(/integrity check/);
  });

  it('refuses an encrypted ZIP entry with a reason', async () => {
    const zip = buildZip([{ name: 'r.xml', content: XML, encryptedFlag: true }]);
    await expect(reportXmlFromAttachment(zip)).rejects.toThrow(/encrypted/);
  });

  it('refuses a truncated ZIP', async () => {
    const zip = buildZip([{ name: 'r.xml', content: XML }]);
    await expect(reportXmlFromAttachment(zip.subarray(0, zip.length - 30))).rejects.toBeInstanceOf(ReportArchiveError);
  });

  it('refuses a ZIP with no report in it', async () => {
    const zip = buildZip([
      { name: 'a.txt', content: 'a' },
      { name: 'b.txt', content: 'b' },
    ]);
    await expect(reportXmlFromAttachment(zip)).rejects.toThrow(/no XML report/);
  });

  it('refuses something that is not a report at all', async () => {
    await expect(reportXmlFromAttachment(Buffer.from('%PDF-1.7 binary'))).rejects.toThrow(/not XML, gzip or ZIP/);
  });

  it('stops a gzip bomb at the size limit instead of inflating it', async () => {
    const bomb = gzipSync(Buffer.alloc(maxReportXmlBytes + 1024, 0x20));
    expect(bomb.length).toBeLessThan(1024 * 1024);
    await expect(reportXmlFromAttachment(bomb)).rejects.toThrow(/decompresses to more than/);
  }, 60_000);

  it('stops a ZIP bomb at the size limit, whatever the directory claims', async () => {
    const zip = buildZip([{ name: 'r.xml', content: Buffer.alloc(maxReportXmlBytes + 1024, 0x20) }]);
    // Lie in both size fields so only the inflate limit stands in the way.
    const directory = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    zip.writeUInt32LE(100, directory + 24);
    zip.writeUInt32LE(100, 22);
    await expect(reportXmlFromAttachment(zip)).rejects.toThrow(/decompresses to more than/);
  }, 60_000);
});
