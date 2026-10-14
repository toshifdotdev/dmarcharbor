import { describe, expect, it } from 'vitest';
import {
  errorFromResponse,
  extractErrorCode,
  genericForStatus,
  readUiError,
} from '../lib/ui-errors.js';

/**
 * Coverage for what a failed request says.
 *
 * Two catch blocks answered every failure with "The request could not be
 * sent.", so a JSON parse failure, a proxy that returned an HTML error page, a
 * refusal the API had explained, and a DNS failure all arrived as the same
 * sentence. The operator could not tell a typo in a form from a broken build,
 * which is the whole reason this module exists.
 */

describe('errorFromResponse', () => {
  it('uses the API own message when the envelope is nested', () => {
    const ui = errorFromResponse(409, JSON.stringify({
      error: { code: 'API_KEY_NAME_TAKEN', message: 'A key called "my-key" already exists.' },
    }));

    expect(ui.status).toBe(409);
    expect(ui.answered).toBe(true);
    expect(ui.message).toBe('A key called "my-key" already exists.');
  });

  it('reads the flattened shape better-auth sends', () => {
    const ui = errorFromResponse(403, JSON.stringify({ message: 'Missing or null Origin', code: 'X' }));

    expect(ui.message).toBe('Missing or null Origin');
    expect(ui.status).toBe(403);
  });

  it('reads the Slack flattened shape where the error itself is the string', () => {
    const ui = errorFromResponse(400, JSON.stringify({ error: 'That webhook URL is not reachable.' }));

    expect(ui.message).toBe('That webhook URL is not reachable.');
  });

  it('does not report an HTML error page as if it were a message', () => {
    // What a proxy returns when the rewrite target is down: not JSON, no reason.
    const ui = errorFromResponse(502, '<html><body>Bad Gateway</body></html>');

    expect(ui.answered).toBe(false);
    expect(ui.message).toContain('502');
  });

  it('reports a 0 status as unreachable rather than as a server fault', () => {
    const ui = errorFromResponse(0, '');

    expect(ui.status).toBe(0);
    expect(ui.message).toMatch(/could not reach/i);
  });

  it('names the field for a short key name, in the words the field needs', () => {
    // This is the shape the API now sends after the Zod mapping landed. It used
    // to send Zod own text, which the UI showed verbatim.
    const ui = errorFromResponse(400, JSON.stringify({
      error: { code: 'INVALID_REQUEST', message: 'Name must be at least 3 characters.' },
    }));

    expect(ui.message).toBe('Name must be at least 3 characters.');
  });

  it('never returns an empty message', () => {
    const ui = errorFromResponse(422, JSON.stringify({ error: { code: 'X', message: '   ' } }));

    expect(ui.message.length).toBeGreaterThan(0);
    expect(ui.status).toBe(422);
  });
});

describe('genericForStatus', () => {
  it('is specific where a status has a meaning a person can act on', () => {
    expect(genericForStatus(401)).toMatch(/not signed in/i);
    expect(genericForStatus(403)).toMatch(/permission/i);
    expect(genericForStatus(404)).toMatch(/could not be found/i);
    expect(genericForStatus(409)).toMatch(/already exists/i);
    expect(genericForStatus(429)).toMatch(/too many/i);
  });

  it('names the code for a server error, because it is the only detail there is', () => {
    expect(genericForStatus(500)).toContain('500');
    expect(genericForStatus(502)).toContain('502');
    expect(genericForStatus(503)).toContain('503');
  });

  it('is generic for a status it has no specific words for', () => {
    for (const status of [418, 451, 499]) {
      expect(genericForStatus(status).length).toBeGreaterThan(0);
    }
  });

  it('says the connection failed for 0', () => {
    expect(genericForStatus(0)).toMatch(/could not reach/i);
  });
});

describe('extractErrorCode', () => {
  it('reads the nested code', () => {
    expect(extractErrorCode(JSON.stringify({ error: { code: 'PLAN_LIMIT_REACHED' } }))).toBe(
      'PLAN_LIMIT_REACHED',
    );
  });

  it('reads a flattened code', () => {
    expect(extractErrorCode(JSON.stringify({ code: 'BAD_REQUEST' }))).toBe('BAD_REQUEST');
  });

  it('returns null when there is no code, rather than inventing one', () => {
    expect(extractErrorCode('')).toBeNull();
    expect(extractErrorCode('not json')).toBeNull();
    expect(extractErrorCode(JSON.stringify({ error: { message: 'no code here' } }))).toBeNull();
  });

  it('survives a Slack-style string error', () => {
    expect(extractErrorCode(JSON.stringify({ error: 'a string' }))).toBe('REQUEST_FAILED');
  });
});

describe('readUiError', () => {
  it('shapes a real Response', async () => {
    const res = new Response(JSON.stringify({ error: { message: 'No.' } }), { status: 403 });
    const ui = await readUiError(res);

    expect(ui.message).toBe('No.');
    expect(ui.status).toBe(403);
  });

  it('reports the status when the body cannot be read at all', async () => {
    const res = new Response('x', { status: 503 });
    Object.defineProperty(res, 'text', { value: () => Promise.reject(new Error('stream dead')) });

    const ui = await readUiError(res);

    expect(ui.status).toBe(503);
    expect(ui.answered).toBe(false);
    expect(ui.message).toContain('503');
  });
});
