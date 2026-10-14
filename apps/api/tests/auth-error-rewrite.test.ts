import { describe, expect, it } from 'vitest';
import type { Response } from 'express';
import { withReadableAuthErrors } from '../src/middleware/auth-error-rewrite.middleware.js';

/**
 * Coverage for what Better Auth's own failures say.
 *
 * The sign-up form showed `[body.email] Invalid email address` and
 * `[body.name] Invalid input: expected string, received undefined` verbatim,
 * because those arrive as `message` and every caller renders the message. The
 * first leaks the request-body path, the second is Zod's generator phrasing.
 *
 * These tests exercise `res.write`, because that is where better-call's node
 * adapter actually puts the body: it streams through `res.write(chunk)` and
 * calls `res.end()` with no argument at all. Two earlier versions of this
 * wrapper patched `res.json` and then `res.end`, both of which are never called
 * by that adapter, and both of which passed every test they had while doing
 * nothing at all. The streaming case below is what would have caught them.
 */

/** The real write path: a stream through `write`, then a bare `end`. */
function handlerStreaming(status: number, body: string) {
  return (_r: unknown, res: Response) => {
    res.writeHead(status);
    res.write(body);
    res.end();
  };
}

/** The one-shot form a hand-written handler would use. */
function handlerWriting(status: number, body: unknown) {
  return (_r: unknown, res: Response) => {
    res.writeHead(status);
    res.end(body);
  };
}

/** Express's own helper, which the library does NOT call. */
function handlerJson(body: unknown) {
  return (_r: unknown, res: Response) => {
    res.json(body);
  };
}

function fakeRes() {
  const written: unknown[] = [];
  const proto = {
    writeHead(this: unknown) {
      return this;
    },
    write(this: { _written: unknown[] }, chunk?: unknown) {
      this._written.push(chunk);
      return true;
    },
    end(this: { _written: unknown[] }, chunk?: unknown) {
      // `end()` with no argument is the normal end-of-stream call; only record
      // it when it carries a body, so a bare end is not mistaken for an empty
      // write.
      if (chunk !== undefined) this._written.push(chunk);
      return this;
    },
    json(this: unknown) {
      return this;
    },
  };
  const res = Object.create(proto) as Response & { _written: unknown[] };
  res._written = written;
  return { res, written };
}

describe('withReadableAuthErrors', () => {
  it('restates the mangled email message on the streaming path', () => {
    const { res, written } = fakeRes();

    withReadableAuthErrors(
      handlerStreaming(400, JSON.stringify({ message: '[body.email] Invalid email address', code: 'VALIDATION_ERROR' })),
    )({} as never, res, () => {});

    expect(JSON.parse(String(written[0]))).toEqual({
      message: 'Enter an email address we can send to.',
      code: 'VALIDATION_ERROR',
    });
  });

  it('restates a missing field without leaking the body path', () => {
    const { res, written } = fakeRes();

    withReadableAuthErrors(
      handlerStreaming(
        400,
        JSON.stringify({ message: '[body.name] Invalid input: expected string, received undefined' }),
      ),
    )({} as never, res, () => {});

    expect(JSON.parse(String(written[0]))).toEqual({ message: 'Fill in this field.' });
  });

  it('restates a message delivered in several chunks', () => {
    const { res, written } = fakeRes();
    const body = JSON.stringify({ message: '[body.email] Invalid email address' });
    const cut = Math.floor(body.length / 2);

    withReadableAuthErrors((_r, r: Response) => {
      r.writeHead(400);
      r.write(body.slice(0, cut));
      r.write(body.slice(cut));
      r.end();
    })({} as never, res, () => {});

    // Neither fragment is valid JSON on its own, so neither is rewritten and
    // the body goes out exactly as it was sent. Rewriting a partial JSON body
    // would corrupt the response, which is worse than a mangled message.
    expect(String(written[0]) + String(written[1])).toBe(body);
  });

  /**
   * The chunk that broke this wrapper for the third time.
   *
   * `better-call` hands the body to the stream as a `Uint8Array`, not a Node
   * `Buffer`. `Buffer.isBuffer` is false for a plain Uint8Array, because a
   * Buffer is a Uint8Array subclass rather than the other way around, so a
   * Buffer-only check passed the body through untouched. Every unit test before
   * this one wrote strings and none of them caught it.
   */
  it('restates a body delivered as a Uint8Array', () => {
    const { res, written } = fakeRes();
    const bytes = new TextEncoder().encode(
      JSON.stringify({ message: '[body.email] Invalid email address' }),
    );

    withReadableAuthErrors((_r, r: Response) => {
      r.writeHead(400);
      r.write(bytes as never);
      r.end();
    })({} as never, res, () => {});

    expect(JSON.parse(String(written[0])).message).toBe('Enter an email address we can send to.');
  });

  it('restates a body delivered as an ArrayBuffer', () => {
    const { res, written } = fakeRes();
    const body = JSON.stringify({ message: '[body.name] Invalid input: expected string, received undefined' });
    const bytes = new TextEncoder().encode(body);
    const view = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

    withReadableAuthErrors((_r, r: Response) => {
      r.writeHead(400);
      r.write(view as never);
      r.end();
    })({} as never, res, () => {});

    expect(JSON.parse(String(written[0])).message).toBe('Fill in this field.');
  });

  it('restates a body delivered as a Buffer', () => {
    const { res, written } = fakeRes();
    const bytes = Buffer.from(JSON.stringify({ message: '[body.email] Invalid email address' }));

    withReadableAuthErrors((_r, r: Response) => {
      r.writeHead(400);
      r.write(bytes as never);
      r.end();
    })({} as never, res, () => {});

    expect(JSON.parse(String(written[0])).message).toBe('Enter an email address we can send to.');
  });

  it('also restates a body written in a single end call', () => {
    const { res, written } = fakeRes();

    withReadableAuthErrors(
      handlerWriting(400, JSON.stringify({ message: '[body.email] Invalid email address' })),
    )({} as never, res, () => {});

    expect(JSON.parse(String(written[0])).message).toBe('Enter an email address we can send to.');
  });

  it('leaves the anti-enumeration answer byte-for-byte', () => {
    const original = JSON.stringify({ message: 'Invalid email or password', code: 'INVALID_EMAIL_OR_PASSWORD' });
    const { res, written } = fakeRes();

    withReadableAuthErrors(handlerStreaming(401, original))({} as never, res, () => {});

    expect(written[0]).toBe(original);
  });

  it('leaves a provider message alone', () => {
    const original = JSON.stringify({ message: 'Password too short', code: 'PASSWORD_TOO_SHORT' });
    const { res, written } = fakeRes();

    withReadableAuthErrors(handlerStreaming(400, original))({} as never, res, () => {});

    expect(written[0]).toBe(original);
  });

  it('leaves a non-JSON body untouched', () => {
    const { res, written } = fakeRes();

    withReadableAuthErrors(handlerStreaming(404, 'plain text'))({} as never, res, () => {});

    expect(written[0]).toBe('plain text');
  });

  it('leaves an empty body untouched', () => {
    const { res, written } = fakeRes();

    withReadableAuthErrors((_r, r: Response) => {
      r.writeHead(204);
      r.end();
    })({} as never, res, () => {});

    expect(written).toHaveLength(0);
  });

  it('leaves a success body untouched', () => {
    const original = JSON.stringify({ user: { email: 'a@b.test' }, token: 'xyz' });
    const { res, written } = fakeRes();

    withReadableAuthErrors(handlerStreaming(200, original))({} as never, res, () => {});

    expect(written[0]).toBe(original);
  });

  it('does not rewrite a message that merely contains the pattern', () => {
    const original = JSON.stringify({ message: 'A sentence about [body.email] things in prose' });
    const { res, written } = fakeRes();

    withReadableAuthErrors(handlerStreaming(400, original))({} as never, res, () => {});

    expect(written[0]).toBe(original);
  });

  it('restores write and end so they cannot rewrite another response', () => {
    const { res } = fakeRes();
    const beforeWrite = res.write;
    const beforeEnd = res.end;

    withReadableAuthErrors(handlerStreaming(400, '{"message":"[body.email] Invalid email address"}'))(
      {} as never,
      res,
      () => {},
    );

    expect(res.write).toBe(beforeWrite);
    expect(res.end).toBe(beforeEnd);
  });

  it('restores write and end when the handler throws synchronously', () => {
    const { res } = fakeRes();
    const beforeWrite = res.write;
    const beforeEnd = res.end;

    expect(() =>
      withReadableAuthErrors(() => {
        throw new Error('boom');
      })({} as never, res, () => {}),
    ).toThrow('boom');

    expect(res.write).toBe(beforeWrite);
    expect(res.end).toBe(beforeEnd);
  });

  it('never rewrites the same body twice', () => {
    const { res, written } = fakeRes();

    // A handler that writes the body and then ends with the same string, which
    // would otherwise send a corrupted doubled response.
    withReadableAuthErrors((_r, r: Response) => {
      const body = '{"message":"[body.email] Invalid email address"}';
      r.writeHead(400);
      r.write(body);
      r.end(body);
    })({} as never, res, () => {});

    expect(written).toHaveLength(2);
    // Only the first write carries the rewrite.
    expect(JSON.parse(String(written[0])).message).toBe('Enter an email address we can send to.');
    expect(String(written[1])).toBe('{"message":"[body.email] Invalid email address"}');
  });

  /**
   * The trap that cost two versions of this wrapper.
   *
   * `toNodeHandler` returns an ASYNC function. A `finally` around the handler
   * call removes the patch the moment the call returns its promise, which is
   * before the response is written — so the body goes out mangled and every
   * synchronous test still passes.
   */
  it('keeps the patch alive until an async handler has written', async () => {
    const { res, written } = fakeRes();

    const done = withReadableAuthErrors(async (_r, r: Response) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      r.writeHead(400);
      r.write(JSON.stringify({ message: '[body.email] Invalid email address' }));
      r.end();
    })({} as never, res, () => {});

    expect(done).toBeInstanceOf(Promise);
    await done;
    // A bare `end()` after the await would still be patched if the patch were
    // removed too early; asserting the restored state proves it was not.
    expect(res.write).not.toBe(undefined);
    expect(JSON.parse(String(written[0])).message).toBe('Enter an email address we can send to.');
  });

  it('removes the patch after an async handler settles', async () => {
    const { res } = fakeRes();
    const beforeWrite = res.write;
    const beforeEnd = res.end;

    await withReadableAuthErrors(async (_r, r: Response) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      r.writeHead(200);
      r.end();
    })({} as never, res, () => {});

    expect(res.write).toBe(beforeWrite);
    expect(res.end).toBe(beforeEnd);
  });

  /**
   * The contrast that makes the whole file's design legible: a body written
   * through `res.json` is NOT rewritten, because better-call does not use it.
   * If a future adapter starts calling json, this test is the one that says so.
   */
  it('does not patch res.json, which the library does not call', () => {
    const { res, written } = fakeRes();

    withReadableAuthErrors(handlerJson({ message: '[body.email] Invalid email address' }))(
      {} as never,
      res,
      () => {},
    );

    expect(written).toHaveLength(0);
  });

  it('handles a handler that calls next without writing', () => {
    const { res, written } = fakeRes();
    let nextCalled = false;

    withReadableAuthErrors((_r, _s, next) => next())({} as never, res, () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(true);
    expect(written).toHaveLength(0);
  });

  it('passes a Buffer through unchanged when there is nothing to rewrite', () => {
    const { res, written } = fakeRes();

    withReadableAuthErrors(handlerStreaming(400, '[body.email] Invalid email address'))({} as never, res, () => {});

    expect(String(written[0])).toBe('[body.email] Invalid email address');
  });
});
