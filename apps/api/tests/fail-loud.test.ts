import { describe, expect, it } from 'vitest';
import { clientKey } from '../src/middleware/rate-limit.middleware.js';
import { redactUrlSecrets, resolveRequestId } from '../src/middleware/request-context.middleware.js';

/**
 * Unit coverage for the two pure helpers introduced while making the service
 * fail loudly. Both are security relevant and both are easy to regress without a
 * test: one silently narrows a bucket, the other silently leaks a credential.
 */

describe('request log redaction', () => {
  it('never writes a share token to the log line', () => {
    const token = 'kR3yT0kenValue_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';
    const line = redactUrlSecrets(`/api/reports/share/${token}`);

    expect(line).not.toContain(token);
    expect(line).toBe('/api/reports/share/[redacted]');
  });

  it('never writes an export download token to the log line', () => {
    const token = 'exportDownloadToken0123456789abcdefGHIJKLMNOPQRSTUVWXYZ';
    const line = redactUrlSecrets(`/api/exports/abc123/download?token=${token}`);

    expect(line).not.toContain(token);
    expect(line).toBe('/api/exports/abc123/download?token=[redacted]');
  });

  it('redacts regardless of query parameter casing', () => {
    expect(redactUrlSecrets('/x?Token=secretvalue')).not.toContain('secretvalue');
    expect(redactUrlSecrets('/x?DOWNLOAD_TOKEN=secretvalue')).not.toContain('secretvalue');
    expect(redactUrlSecrets('/x?access_token=secretvalue')).not.toContain('secretvalue');
  });

  it('redacts a token sitting among other query parameters', () => {
    const line = redactUrlSecrets('/api/exports/1/download?token=abc123def456&format=pdf');
    expect(line).not.toContain('abc123def456');
    expect(line).toContain('format=pdf');
  });

  it('leaves a public trust slug readable, because it is meant to be shared', () => {
    const slug = 'aB3xY9zQ-public-trust-slug-value';
    expect(redactUrlSecrets(`/api/trust/${slug}`)).toBe(`/api/trust/${slug}`);
  });

  it('leaves an ordinary URL untouched', () => {
    const url = '/api/workspaces/org_123/clients?limit=50';
    expect(redactUrlSecrets(url)).toBe(url);
  });
});

describe('request id handling', () => {
  it('accepts a well formed inbound id so traces stay correlatable', () => {
    expect(resolveRequestId('abc12345')).toBe('abc12345');
  });

  it('rejects a malformed inbound id rather than propagating it into headers and logs', () => {
    const generated = resolveRequestId('has spaces and <script>');
    expect(generated).not.toBe('has spaces and <script>');
    expect(generated).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('generates an id when none is supplied', () => {
    expect(resolveRequestId(undefined)).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('rate limit bucket keying', () => {
  it('keeps IPv4 callers in distinct buckets', () => {
    expect(clientKey({ ip: '203.0.113.7' })).toBe('v4:203.0.113.7');
    expect(clientKey({ ip: '203.0.113.8' })).not.toBe(clientKey({ ip: '203.0.113.7' }));
  });

  it('collapses a whole IPv6 /64 into one bucket so it cannot be walked', () => {
    // Two addresses in the same /64. Keyed on the full address these would be
    // separate buckets, which is exactly the rotation evasion this prevents.
    const first = clientKey({ ip: '2001:db8:1:2:aaaa:bbbb:cccc:dddd' });
    const second = clientKey({ ip: '2001:db8:1:2:ffff:eeee:dddd:cccc' });
    expect(first).toBe(second);
  });

  it('still separates genuinely different IPv6 networks', () => {
    expect(clientKey({ ip: '2001:db8:1:2::1' })).not.toBe(clientKey({ ip: '2001:db8:9:9::1' }));
  });

  it('treats an IPv4-mapped IPv6 address as the IPv4 address it is', () => {
    expect(clientKey({ ip: '::ffff:203.0.113.7' })).toBe(clientKey({ ip: '203.0.113.7' }));
  });

  it('falls back to the socket address and then to a literal', () => {
    expect(clientKey({ socket: { remoteAddress: '198.51.100.4' } })).toBe('v4:198.51.100.4');
    expect(clientKey({})).toBe('v4:unknown');
  });

  it('strips an IPv6 zone identifier before bucketing', () => {
    expect(clientKey({ ip: 'fe80::1%eth0' })).toBe(clientKey({ ip: 'fe80::1' }));
  });
});