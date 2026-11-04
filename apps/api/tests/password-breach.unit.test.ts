import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { PWNED_RANGE_URL, countInRange, passwordBreachCount, pwnedHashParts } from '../src/auth/password-breach.js';

const password = 'correct-horse-battery-staple';
const sha1 = createHash('sha1').update(password).digest('hex').toUpperCase();

function rangeResponse(body: string, status = 200): Response {
  return new Response(body, { status });
}

describe('Have I Been Pwned range check', () => {
  it('splits the SHA-1 after five characters, upper case', () => {
    expect(pwnedHashParts(password)).toEqual({ prefix: sha1.slice(0, 5), suffix: sha1.slice(5) });
  });

  it('sends only the five-character prefix, with padding asked for', async () => {
    const fetchImpl = vi.fn(async () => rangeResponse('0000000000000000000000000000000000A:3'));
    await passwordBreachCount(password, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${PWNED_RANGE_URL}${sha1.slice(0, 5)}`);
    expect(url).not.toContain(sha1.slice(5));
    expect((init.headers as Record<string, string>)['Add-Padding']).toBe('true');
  });

  it('reports the count for a listed suffix, whatever its case', async () => {
    const body = ['0018A45C4D1DEF81644B54AB7F969B88D65:1', `${sha1.slice(5).toLowerCase()}:42`, 'FFFFF:0'].join('\r\n');
    expect(await passwordBreachCount(password, async () => rangeResponse(body))).toBe(42);
  });

  it('reports zero when the suffix is not listed, or only as padding', async () => {
    expect(await passwordBreachCount(password, async () => rangeResponse('0018A45C4D1DEF81644B54AB7F969B88D65:1'))).toBe(0);
    expect(countInRange(`${sha1.slice(5)}:0`, sha1.slice(5))).toBe(0);
  });

  it('answers null, not a verdict, when the service fails or cannot be reached', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await passwordBreachCount(password, async () => rangeResponse('busy', 503))).toBeNull();
    expect(
      await passwordBreachCount(password, async () => {
        throw new TypeError('fetch failed');
      }),
    ).toBeNull();
    warn.mockRestore();
  });
});
