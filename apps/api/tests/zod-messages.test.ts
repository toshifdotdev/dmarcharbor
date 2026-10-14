import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { zodMessage } from '../src/utils/zod-messages.js';

/**
 * Coverage for the Zod-to-human mapping, which replaced ten copies of
 * `issues[0]?.message`.
 *
 * The API was sending Zod's own generator text as `error.message`, and the
 * browser shows that string verbatim. "String must contain at least 3
 * character(s)" is what an operator saw when they typed a two-letter key name,
 * and "Array must contain at least 1 element(s)" when they cleared every scope
 * box. Neither says which field or what to do.
 */

describe('zodMessage', () => {
  it('names the field and the constraint for a short string', () => {
    const schema = z.object({ name: z.string().min(3) });
    const result = schema.safeParse({ name: 'ab' });

    expect(result.success).toBe(false);
    expect(zodMessage(result.error?.issues)).toBe('Name must be at least 3 characters.');
  });

  it('names the field for an empty array', () => {
    const schema = z.object({ scopes: z.array(z.enum(['read', 'write'])).min(1) });
    const result = schema.safeParse({ scopes: [] });

    expect(result.success).toBe(false);
    // "must have" rather than "needs": the field is plural, and "Scopes needs"
    // reads as a typo. "must have" carries no number agreement.
    expect(zodMessage(result.error?.issues)).toBe('Scopes must have at least 1 item.');
  });

  it('pluralises a bigger minimum', () => {
    const schema = z.object({ events: z.array(z.string()).min(2) });
    const result = schema.safeParse({ events: ['a'] });

    expect(result.success).toBe(false);
    expect(zodMessage(result.error?.issues)).toBe('Events must have at least 2 items.');
  });

  it('says what an email field wants', () => {
    const schema = z.object({ email: z.string().email() });
    const result = schema.safeParse({ email: 'not-an-email' });

    expect(result.success).toBe(false);
    expect(zodMessage(result.error?.issues)).toBe('Email must be an email address.');
  });

  it('says a URL must be https for a value that is not a URL at all', () => {
    // A bare string that is not a URL: `string.url()` rejects it before any
    // protocol can be considered, so this is the case being described rather
    // than "http is insecure", which the enum below covers.
    const schema = z.object({ url: z.string().url() });
    const result = schema.safeParse({ url: 'not-a-url' });

    expect(result.success).toBe(false);
    expect(zodMessage(result.error?.issues)).toBe('Url must be a URL starting with https.');
  });

  it('names the field for an http URL the project refuses', () => {
    // The real constraint in this codebase: the target comes from DNS, so a
    // fetch over http trusts XML anyone on the path can rewrite. Zod emits
    // "Invalid input: must start with "https://"" for this, which is as much
    // generator text as the too_small codes.
    const schema = z.object({ url: z.string().url().startsWith('https://') });
    const result = schema.safeParse({ url: 'http://insecure.example' });

    expect(result.success).toBe(false);
    // The field is named, and the jargon is gone. "must be a URL" was the
    // previous assertion; what matters is that Zod's own words do not reach a
    // person, and the field does.
    expect(zodMessage(result.error?.issues)).toBe('Url is not in the right format.');
  });

  it('uses the last path segment, so a nested field is named by its own label', () => {
    const schema = z.object({ contact: z.object({ email: z.string().email() }) });
    const result = schema.safeParse({ contact: { email: 'nope' } });

    expect(result.success).toBe(false);
    // "Email", not "Contact.email": the operator is looking at the email input.
    expect(zodMessage(result.error?.issues)).toBe('Email must be an email address.');
  });

  it('capitalises camelCase field names into words', () => {
    const schema = z.object({ expiresInDays: z.number().min(1) });
    const result = schema.safeParse({ expiresInDays: 0 });

    expect(result.success).toBe(false);
    expect(zodMessage(result.error?.issues)).toBe('Expires in days must be at least 1.');
  });

  it('expands the enum the field expects', () => {
    const schema = z.object({ plan: z.enum(['FAIRWAY', 'HARBOR']) });
    const result = schema.safeParse({ plan: 'MOORING' });

    expect(result.success).toBe(false);
    expect(zodMessage(result.error?.issues)).toContain('FAIRWAY, HARBOR');
  });

  it('reports the first issue only, so a form highlights one field at a time', () => {
    const schema = z.object({ email: z.string().email(), name: z.string().min(3) });
    const result = schema.safeParse({ email: 'bad', name: 'x' });

    expect(result.success).toBe(false);
    expect(zodMessage(result.error?.issues)).toBe('Email must be an email address.');
  });

  /**
   * The case that made SSO's controller keep its own message.
   *
   * `superRefine` produces a `custom` issue carrying an author-written sentence,
   * and that sentence is the one an administrator needs. Autogenerated text is
   * restated; hand-written text is passed through untouched.
   */
  it('passes a refinement message through rather than rewriting it', () => {
    // A superRefine that adds a custom issue only when the value is wrong.
    // Object.safeParse on its own succeeds, so the issue has to be provoked by
    // the refinement rather than by a schema-level constraint.
    const schema = z
      .object({ issuer: z.string() })
      .superRefine((value, ctx) => {
        if (value.issuer.includes('/realms/')) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'The issuer must not carry a path. Use the discovery base URL.',
          });
        }
      });
    const result = schema.safeParse({ issuer: 'https://idp.example/realms/x' });

    expect(result.success).toBe(false);
    expect(zodMessage(result.error?.issues)).toBe(
      'The issuer must not carry a path. Use the discovery base URL.',
    );
  });

  it('handles a top-level constraint with no field path', () => {
    const result = z.string().min(5).safeParse('ab');

    expect(result.success).toBe(false);
    expect(zodMessage(result.error?.issues)).toContain('This field');
  });

  it('falls back to something readable when there is no issue at all', () => {
    expect(zodMessage(undefined)).toBe('That request is not valid.');
    expect(zodMessage([])).toBe('That request is not valid.');
  });

  it('never emits Zod own generator phrasing', () => {
    const cases = [
      z.object({ a: z.string().min(3) }).safeParse({ a: 'x' }),
      z.object({ b: z.array(z.string()).min(1) }).safeParse({ b: [] }),
      z.object({ c: z.string().email() }).safeParse({ c: 'no' }),
      z.object({ d: z.enum(['x']) }).safeParse({ d: 'y' }),
      z.object({ e: z.string().max(2) }).safeParse({ e: 'toolong' }),
    ];

    for (const result of cases) {
      expect(result.success).toBe(false);
      const message = zodMessage(result.error?.issues);
      // The phrases that reached the browser.
      expect(message).not.toMatch(/must contain at least \d+ character/);
      expect(message).not.toMatch(/must contain at least \d+ element/);
      expect(message).not.toMatch(/Invalid enum value/);
      expect(message).not.toMatch(/Invalid input/);
    }
  });
});
