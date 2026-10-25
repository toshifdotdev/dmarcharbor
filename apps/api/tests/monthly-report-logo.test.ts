import { describe, expect, it, vi } from 'vitest';
import {
  inspectReportLogo,
  loadMonthlyReportLogo,
  maxMonthlyReportLogoBytes,
} from '../src/services/reports/monthly-report-logo.js';

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('rest of the image'),
]);
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from('rest of the image')]);
const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
const webp = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([0, 0, 0, 0]),
  Buffer.from('WEBP'),
  Buffer.from('rest'),
]);

describe('monthly report logo checks', () => {
  it('accepts PNG and JPEG and refuses SVG and WebP', () => {
    expect(inspectReportLogo(png)?.contentType).toBe('image/png');
    expect(inspectReportLogo(jpeg)?.contentType).toBe('image/jpeg');
    expect(inspectReportLogo(svg)).toBeNull();
    expect(inspectReportLogo(webp)).toBeNull();
  });

  it('refuses an image over the 512 KB cap', () => {
    const huge = Buffer.concat([png, Buffer.alloc(maxMonthlyReportLogoBytes)]);
    expect(inspectReportLogo(huge)).toBeNull();
  });

  it('refuses a private address before making a request', async () => {
    const fetchImpl = vi.fn();
    const result = await loadMonthlyReportLogo('https://10.0.0.1/logo.png', { fetchImpl });
    expect(result).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses loopback in every environment, including tests', async () => {
    const fetchImpl = vi.fn();
    const result = await loadMonthlyReportLogo('https://127.0.0.1/logo.png', { fetchImpl });
    expect(result).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a hostname that resolves to a private address', async () => {
    const fetchImpl = vi.fn();
    const result = await loadMonthlyReportLogo('https://public-looking.example/logo.png', {
      fetchImpl,
      lookup: async () => [{ address: '192.168.1.10' }],
    });
    expect(result).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('loads a PNG from a public https host', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(png, { status: 200, headers: { 'content-length': String(png.length) } }),
    );
    const result = await loadMonthlyReportLogo('https://cdn.example/logo.png', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      lookup: async () => [{ address: '203.0.113.10' }],
    });
    expect(result?.contentType).toBe('image/png');
    expect(result?.bytes.equals(png)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
