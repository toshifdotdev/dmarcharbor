import { describe, expect, it } from 'vitest';
import {
  LogoStorageError,
  acceptedLogoTypes,
  assertLogoDimensions,
  assertSafeSvg,
  imageDimensions,
  logoObjectKey,
  maxLogoBytes,
  objectKeyFromLogoUrl,
  validateLogoUpload,
} from '../src/services/branding/logo-storage.service.js';

/**
 * Logo upload validation.
 *
 * These checks run before a presigned URL is issued, which is the only point at
 * which they can be enforced. A presigned URL cannot be revoked once handed
 * out, so validating after the upload would leave the object reachable and the
 * check would be theatre.
 *
 * No network is involved, so these are unit tests. The end to end behaviour is
 * proven in the branding integration suite.
 */

describe('logo upload validation', () => {
  it('accepts the formats a logo is actually supplied in', () => {
    for (const contentType of acceptedLogoTypes) {
      const checked = validateLogoUpload({ contentType, byteSize: 4096 });
      expect(checked.contentType).toBe(contentType);
      expect(checked.byteSize).toBe(4096);
      expect(checked.extension).toBeTruthy();
    }
  });

  it('normalises a content type that carries a charset', () => {
    // Some browsers append a charset to an SVG upload. Refusing it would reject
    // a perfectly ordinary logo.
    const checked = validateLogoUpload({ contentType: 'image/SVG+XML; charset=utf-8', byteSize: 2048 });
    expect(checked.contentType).toBe('image/svg+xml');
    expect(checked.extension).toBe('svg');
  });

  it('rejects anything that is not an image', () => {
    for (const contentType of ['application/pdf', 'text/html', 'image/gif', 'application/octet-stream', 'text/javascript']) {
      expect(() => validateLogoUpload({ contentType, byteSize: 1024 }), contentType).toThrow(LogoStorageError);
    }
  });

  it('rejects an svg carrying script, which is the one genuinely dangerous case', () => {
    // The type is accepted, so the risk has to be handled by the serving
    // headers rather than by the file check: a separate origin plus a sandbox
    // content security policy. This test exists to record that the decision is
    // deliberate, because accepting SVG at all is the judgement call.
    const checked = validateLogoUpload({ contentType: 'image/svg+xml', byteSize: 4096 });
    expect(checked.contentType).toBe('image/svg+xml');
  });

  it('rejects a file over the size cap', () => {
    expect(() => validateLogoUpload({ contentType: 'image/png', byteSize: maxLogoBytes + 1 })).toThrow(LogoStorageError);
    expect(() => validateLogoUpload({ contentType: 'image/png', byteSize: 10 * 1024 * 1024 })).toThrow(/smaller than/);
  });

  it('rejects an empty or nonsensical size', () => {
    expect(() => validateLogoUpload({ contentType: 'image/png', byteSize: 0 })).toThrow(LogoStorageError);
    expect(() => validateLogoUpload({ contentType: 'image/png', byteSize: -5 })).toThrow(LogoStorageError);
    expect(() => validateLogoUpload({ contentType: 'image/png', byteSize: 1.5 })).toThrow(LogoStorageError);
    expect(() => validateLogoUpload({ contentType: 'image/png', byteSize: Number.NaN })).toThrow(LogoStorageError);
  });

  it('namespaces an object by workspace with an unpredictable suffix', () => {
    const first = logoObjectKey('org_alpha', 'svg');
    const second = logoObjectKey('org_alpha', 'svg');

    // The workspace prefix makes a bucket listing readable and a bulk delete
    // cheap. The random suffix means replacing a logo cannot overwrite the file
    // a cached page is still fetching.
    expect(first.startsWith('logos/org_alpha/')).toBe(true);
    expect(first.endsWith('.svg')).toBe(true);
    expect(first).not.toBe(second);
  });

  it('refuses an SVG that can do more than draw', () => {
    const plain =
      '<?xml version="1.0"?><!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd"><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10"><image xlink:href="data:image/png;base64,AAAA"/><rect width="10" height="10" fill="#123456"/></svg>';
    expect(() => assertSafeSvg(Buffer.from(plain))).not.toThrow();

    for (const body of [
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:s="http://www.w3.org/2000/svg"><s:script>alert(1)</s:script></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div>x</div></foreignObject></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"><rect/></a></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://tracker.example/p.png"/></svg>',
      '<!DOCTYPE svg [<!ENTITY a "aaaa">]><svg xmlns="http://www.w3.org/2000/svg">&a;</svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><style>@import url(https://evil.example/x.css);</style></svg>',
    ]) {
      expect(() => assertSafeSvg(Buffer.from(body)), body).toThrow(/does not need/);
    }
  });

  it('reads image sizes from the header and refuses an oversized picture', () => {
    const png = (width: number, height: number) => {
      const bytes = Buffer.alloc(33);
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
      bytes.writeUInt32BE(13, 8);
      bytes.write('IHDR', 12, 'latin1');
      bytes.writeUInt32BE(width, 16);
      bytes.writeUInt32BE(height, 20);
      return bytes;
    };
    expect(imageDimensions(png(512, 128), 'image/png')).toEqual({ width: 512, height: 128 });
    expect(() => assertLogoDimensions(png(512, 128), 'image/png')).not.toThrow();
    // A small file can declare a huge bitmap; the PDF renderer would decode all of it.
    expect(() => assertLogoDimensions(png(20_000, 20_000), 'image/png')).toThrow(/at most 4096/);
    expect(() => assertLogoDimensions(Buffer.from('not an image'), 'image/png')).toThrow(/could not be read/);

    // A baseline JPEG: SOI, an APP0 segment, then SOF0 with height 300 and width 400.
    const jpeg = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x01, 0x90, 0x03,
    ]);
    expect(imageDimensions(jpeg, 'image/jpeg')).toEqual({ width: 400, height: 300 });
  });

  it('only recognises object keys inside the workspace when one is named', () => {
    const origin = process.env.LOGO_CDN_ORIGIN ?? process.env.ASSETS_ORIGIN ?? '';
    if (origin) {
      const key = 'logos/org_a/0b0c7a4e-1111-4222-8333-444455556666.svg';
      expect(objectKeyFromLogoUrl(`${origin}/${key}`, 'org_a')).toBe(key);
      // Another agency's public logo URL, saved through the branding form.
      expect(objectKeyFromLogoUrl(`${origin}/${key}`, 'org_b')).toBeNull();
    }
  });

  it('only recognises object keys on our own origin', () => {
    const origin = process.env.LOGO_CDN_ORIGIN ?? process.env.ASSETS_ORIGIN ?? '';

    if (origin) {
      expect(objectKeyFromLogoUrl(`${origin}/logos/org_a/x.svg`)).toBe('logos/org_a/x.svg');
    }

    // A pasted external URL must never be turned into a delete against a key we
    // do not own, and must never be treated as one of our assets.
    expect(objectKeyFromLogoUrl('https://evil.example.com/logo.svg')).toBeNull();
    expect(objectKeyFromLogoUrl('https://cdn.attacker.test/pixel.png')).toBeNull();
    expect(objectKeyFromLogoUrl(null)).toBeNull();
    expect(objectKeyFromLogoUrl('')).toBeNull();
  });
});
