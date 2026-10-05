import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createWorkspaceSchema } from '../src/models/auth.model.js';

/**
 * The web application must send what the API requires.
 *
 * This exists because of a real incident, not a hypothetical one. The API was changed to
 * require two Data Processing Agreement confirmations on workspace creation, so a
 * workspace cannot exist without the acceptance recorded. The backend suite was updated
 * in the same change and stayed green, because every test sent the flags. The web
 * application sends its request from a server action through a typed helper, and it sent
 * neither, so every new user who tried to create an agency received
 * `400 DPA_NOT_ACCEPTED` with no failing test anywhere.
 *
 * Both halves were individually defensible and collectively a broken signup flow. The
 * lesson is not "be careful". It is that the type system did not help either, because
 * the helper's parameter type listed only `name` and `slug` while the API's requirement
 * was enforced at runtime by hand.
 *
 * So the required fields are read out of the live zod schema and the web client is
 * asserted to send all of them. A new required field fails here until the web client is
 * updated, which is the property that was missing.
 *
 * It lives in the API suite rather than a web suite because `apps/web` has no test
 * runner, and because cross-boundary contract checks already live here. Adding a second
 * runner to make one file sit closer to the code it reads would be the more expensive
 * change.
 */

const webRoot = join(process.cwd(), '..', 'web');

function readWebSource(...segments: string[]): string {
  return readFileSync(join(webRoot, ...segments), 'utf8');
}

/** Derived from the live schema, never written out by hand. */
function requiredFields(): string[] {
  return Object.keys(createWorkspaceSchema.shape).sort();
}

/**
 * The keys of the inline parameter type of a web helper.
 *
 * Parsed from source rather than imported, because `api-writes.ts` calls
 * `next/headers`, which needs a request scope and cannot be loaded outside a render.
 */
function parameterKeys(source: string, functionName: string): string[] {
  const start = source.indexOf(`export async function ${functionName}(`);
  expect(start, `${functionName} was not found in the web client`).toBeGreaterThan(-1);

  const signature = source.slice(start, source.indexOf('): Promise', start));
  return [...signature.matchAll(/^\s{2,}(\w+)\??:/gm)].map((match) => match[1] as string).sort();
}

describe('web client honours the workspace creation contract', () => {
  it('sends every field the API requires', () => {
    const required = requiredFields();
    const clientFields = parameterKeys(readWebSource('lib', 'api-writes.ts'), 'createWorkspace');
    const missing = required.filter((field) => !clientFields.includes(field));

    /**
     * A hardcoded list here would drift from the schema and quietly stop checking the
     * field it was written to protect, which is the same failure mode as the bug itself.
     */
    expect(
      missing,
      `The web client's createWorkspace does not send: ${missing.join(', ')}. POST /api/workspaces refuses without them.`,
    ).toEqual([]);
  });

  it('requires the DPA confirmations in the client type rather than defaulting them', () => {
    const source = readWebSource('lib', 'api-writes.ts');
    const start = source.indexOf('export async function createWorkspace(');
    const signature = source.slice(start, source.indexOf('): Promise', start));

    /**
     * Required and typed as the literal `true`.
     *
     * Required is the property that matters: with `?`, dropping the flags at a call site
     * compiled cleanly and failed at runtime on a user's first screen. The literal type
     * is belt and braces, since it refuses a variable that has merely been assigned.
     */
    expect(signature).toMatch(/^\s*dpaHasRead:\s*true;/m);
    expect(signature).toMatch(/^\s*dpaConfirmsAuthority:\s*true;/m);
    expect(signature).not.toMatch(/dpaHasRead\?/);
    expect(signature).not.toMatch(/dpaConfirmsAuthority\?/);
  });

  it('creates the workspace in one call, with no follow-up acceptance', () => {
    const source = readWebSource('app', 'welcome', 'page.tsx');

    /**
     * The two-step shape was the actual defect.
     *
     * The acceptance was recorded by a follow-up call reached only on the happy path,
     * so anything failing between the two left a workspace standing with no acceptance
     * record while the screen said the agreement had been made. One call cannot get out
     * of step with itself.
     */
    expect(source).toMatch(/dpaHasRead:\s*true/);
    expect(source).toMatch(/dpaConfirmsAuthority:\s*true/);
    expect(source).not.toMatch(/acceptDpa\(/);
  });

  it('does not build a workspace creation request anywhere else', () => {
    /**
     * Guarding one call site is not enough if there is a second that was never updated,
     * so every known candidate is checked and a new page cannot quietly reintroduce a
     * creation call without the confirmations.
     */
    const candidates = [
      join('app', 'welcome', 'page.tsx'),
      join('components', 'workspace-form.tsx'),
    ];

    for (const relative of candidates) {
      let source: string;
      try {
        source = readWebSource(relative);
      } catch {
        continue;
      }

      if (source.includes('createWorkspace(')) {
        expect(source, `${relative} creates a workspace without the DPA flags`).toMatch(/dpaHasRead:\s*true/);
      }
    }
  });
});