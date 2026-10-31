import { describe, expect, it } from 'vitest';
import {
  byteLimitLabel,
  messageForThrown,
  statusForThrown,
} from '../src/middleware/global-error.middleware.js';
import { codeForStatus, errorBody } from '../src/utils/api-error.js';

/**
 * Coverage for the thrown-error mapping, which was found broken rather than
 * written defensively.
 *
 * `POST /api/v1/clients` with unquoted JSON keys answered 500 instead of 400.
 * body-parser attaches `statusCode: 400` and `expose: true` to that error, and
 * the handler ignored both, so a client's own malformed payload read as a
 * server fault. It was reachable with no credential at all, so an unauthenticated
 * caller could generate 500s at will, which is what makes it worth a test rather
 * than a note.
 *
 * The other direction matters as much: a Prisma driver error carries the host,
 * port, database name and a statement fragment, and nothing may let that onto the
 * wire. The clamp to 4xx is what keeps `expose: true` on a 5xx from being a
 * disclosure rather than a courtesy.
 */

describe('statusForThrown', () => {
  it('answers a body-parser JSON failure as 400, not 500', () => {
    const error = Object.assign(new SyntaxError("Expected property name or '}'"), {
      expose: true,
      statusCode: 400,
      status: 400,
      type: 'entity.parse.failed',
    });

    expect(statusForThrown(error)).toBe(400);
  });

  it('answers an oversized body as 413', () => {
    const error = Object.assign(new Error('request entity too large'), {
      expose: true,
      statusCode: 413,
      status: 413,
      type: 'entity.too.large',
    });

    expect(statusForThrown(error)).toBe(413);
  });

  it('answers an unparseable body when only `status` is set', () => {
    const error = Object.assign(new Error('bad'), { expose: true, status: 400 });

    expect(statusForThrown(error)).toBe(400);
  });

  it('answers 500 for an error that does not declare itself exposable', () => {
    // The Prisma shape: a status-like number on the object, no expose flag.
    const error = Object.assign(new Error('connection refused'), { statusCode: 500 });

    expect(statusForThrown(error)).toBe(500);
  });

  it('clamps an exposed 5xx back to 500', () => {
    const error = Object.assign(new Error('upstream exploded'), {
      expose: true,
      statusCode: 502,
    });

    expect(statusForThrown(error)).toBe(500);
  });

  it('clamps an exposed 3xx back to 500, because a redirect is not an error to relay', () => {
    const error = Object.assign(new Error('moved'), { expose: true, statusCode: 302 });

    expect(statusForThrown(error)).toBe(500);
  });

  it('answers 500 for a non-integer status', () => {
    const error = Object.assign(new Error('weird'), { expose: true, statusCode: '400' });

    expect(statusForThrown(error)).toBe(500);
  });

  it('answers 500 for null and plain errors', () => {
    expect(statusForThrown(null)).toBe(500);
    expect(statusForThrown(undefined)).toBe(500);
    expect(statusForThrown('a string')).toBe(500);
    expect(statusForThrown(new Error('plain'))).toBe(500);
  });
});

describe('messageForThrown', () => {
  it('passes the library message through, because it names the real fault', () => {
    const error = Object.assign(new SyntaxError("Expected property name or '}'"), {
      expose: true,
      statusCode: 400,
    });

    expect(messageForThrown(error)).toContain('Expected property name');
  });

  it('falls back when the message is absent, empty, or unreasonably long', () => {
    expect(messageForThrown(new Error(''))).toBe('The request could not be parsed.');
    expect(messageForThrown({ expose: true, statusCode: 400 })).toBe('The request could not be parsed.');
    expect(messageForThrown({ expose: true, statusCode: 400, message: 'x'.repeat(400) })).toBe(
      'The request could not be parsed.',
    );
    expect(messageForThrown(null)).toBe('The request could not be parsed.');
  });

  it('never returns a message longer than 300 characters', () => {
    const message = messageForThrown({ message: 'y'.repeat(500) });

    expect(message.length).toBeLessThanOrEqual(300);
  });

  it('says what the limit is when the body is too large', () => {
    // The shape raw-body throws: the limit it enforced, in bytes, on the error.
    const tooLarge = (limit: unknown) =>
      Object.assign(new Error('request entity too large'), {
        expose: true,
        statusCode: 413,
        status: 413,
        type: 'entity.too.large',
        limit,
        length: 20_000,
      });

    const message = messageForThrown(tooLarge(10_240));
    expect(message).toContain('10 KB');
    expect(message).not.toContain('request entity too large');
    expect(message.length).toBeLessThanOrEqual(300);

    expect(messageForThrown(tooLarge(256 * 1024))).toContain('256 KB');
    // No usable limit on the error: still a sentence, never "undefined KB".
    const unknown = messageForThrown(tooLarge(undefined));
    expect(unknown).toContain('larger than this endpoint accepts');
    expect(unknown).not.toContain('undefined');
  });
});

describe('byteLimitLabel', () => {
  it('writes a limit the way a person reads it', () => {
    expect(byteLimitLabel(10_240)).toBe('10 KB');
    expect(byteLimitLabel(5 * 1024 * 1024)).toBe('5 MB');
    expect(byteLimitLabel(1500)).toBe('1500 bytes');
    expect(byteLimitLabel(0)).toBeNull();
    expect(byteLimitLabel(-1)).toBeNull();
    expect(byteLimitLabel(1.5)).toBeNull();
    expect(byteLimitLabel('10kb')).toBeNull();
  });
});

describe('codeForStatus', () => {
  it('names an oversized body PAYLOAD_TOO_LARGE rather than INTERNAL', () => {
    /**
     * A 413 used to fall through the table to INTERNAL, so the envelope said
     * "the service failed" about a request the caller had made too big. The
     * code is what integrations branch on, so it has to name the caller's fix.
     */
    expect(codeForStatus(413)).toBe('PAYLOAD_TOO_LARGE');
    expect(errorBody(413, 'x').error.code).toBe('PAYLOAD_TOO_LARGE');
    // An unreadable charset or encoding is the caller's request too.
    expect(codeForStatus(415)).toBe('INVALID_REQUEST');
  });

  it('keeps the other codes, and INTERNAL for anything unnamed', () => {
    expect(codeForStatus(400)).toBe('INVALID_REQUEST');
    expect(codeForStatus(404)).toBe('NOT_FOUND');
    expect(codeForStatus(429)).toBe('RATE_LIMITED');
    expect(codeForStatus(500)).toBe('INTERNAL');
  });
});
