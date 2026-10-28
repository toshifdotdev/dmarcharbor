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
    const request = vi.fn();
    const result = await loadMonthlyReportLogo('https://10.0.0.1/logo.png', { request });
    expect(result).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });

  it('refuses loopback in every environment, including tests', async () => {
    const request = vi.fn();
    const result = await loadMonthlyReportLogo('https://127.0.0.1/logo.png', { request });
    expect(result).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });

  it('refuses a hostname that resolves to a private address', async () => {
    const request = vi.fn();
    const result = await loadMonthlyReportLogo('https://public-looking.example/logo.png', {
      request,
      lookup: async () => [{ address: '192.168.1.10', family: 4 }],
    });
    expect(result).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });

  it('loads a PNG from a public https host', async () => {
    const request = vi.fn(async () => ({
      status: 'ok' as const,
      statusCode: 200,
      headers: {},
      body: png,
    }));
    const result = await loadMonthlyReportLogo('https://cdn.example/logo.png', {
      request,
      lookup: async () => [{ address: '203.0.113.10', family: 4 }],
    });
    expect(result?.contentType).toBe('image/png');
    expect(result?.bytes.equals(png)).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]).toEqual([
      expect.objectContaining({ method: 'GET', policy: 'strict', maxBytes: maxMonthlyReportLogoBytes }),
    ]);
  });

  it('returns no logo when the host answers an error or a redirect', async () => {
    for (const answer of [
      { status: 'ok' as const, statusCode: 404, headers: {}, body: Buffer.from('') },
      { status: 'error' as const, failure: 'redirect' as const, statusCode: 302, detail: 'redirect' },
    ]) {
      const result = await loadMonthlyReportLogo('https://cdn.example/logo.png', {
        request: async () => answer,
        lookup: async () => [{ address: '203.0.113.10', family: 4 }],
      });
      expect(result).toBeNull();
    }
  });
});
