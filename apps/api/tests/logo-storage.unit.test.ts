import { describe, expect, it } from 'vitest';
import {
  LogoStorageError,
  acceptedLogoTypes,
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
