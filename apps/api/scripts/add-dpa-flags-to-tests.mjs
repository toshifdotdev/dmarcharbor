/**
 * One-off maintenance script.
 *
 * Adds the two required Data Processing Agreement confirmations to every test that
 * creates a workspace through `POST /api/workspaces`, because the endpoint now
 * refuses without them.
 *
 * Bracket aware rather than a regular expression. A regex over these files matched
 * inside a template literal on the first attempt and produced
 * `${Date.now(), dpaHasRead: true}` - wrong in a way no failure would explain.
 *
 * Idempotent: a body that already carries the flags is left alone.
 *
 * The interior of the object is written out exactly once, with the flags appended
 * after the last property. An earlier version re-emitted the whole body and
 * duplicated every property in the call.
 */

import { readFileSync, writeFileSync, globSync } from 'node:fs';

const FLAGS = 'dpaHasRead: true, dpaConfirmsAuthority: true';
const files = globSync('tests/**/*.ts');

let changedFiles = 0;
let changedCalls = 0;

for (const file of files) {
  const source = readFileSync(file, 'utf8');
  const pieces = [];
  let cursor = 0;
  let fileChanged = false;

  for (;;) {
    const single = source.indexOf("post('/api/workspaces')", cursor);
    const tpl = source.indexOf('post(`/api/workspaces`)', cursor);

    let at;
    let needle;
    if (single >= 0 && (tpl < 0 || single < tpl)) {
      at = single;
      needle = "post('/api/workspaces')";
    } else if (tpl >= 0) {
      at = tpl;
      needle = 'post(`/api/workspaces`)';
    } else {
      break;
    }

    const sendAt = source.indexOf('.send(', at + needle.length);
    if (sendAt < 0) break;

    const braceAt = source.indexOf('{', sendAt);
    if (braceAt < 0) break;

    let depth = 0;
    let end = -1;
    for (let i = braceAt; i < source.length; i += 1) {
      const ch = source[i];
      if (ch === '{') {
        depth += 1;
      } else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      } else if (ch === "'" || ch === '"' || ch === '`') {
        const quote = ch;
        i += 1;
        while (i < source.length && source[i] !== quote) {
          if (source[i] === '\\') i += 1;
          i += 1;
        }
      }
    }
    if (end < 0) break;

    // Interior only: everything between the braces.
    const interior = source.slice(braceAt + 1, end);

    // Everything up to and including the opening brace. Stopping at `end` instead
    // would emit the interior here and then again in the rebuilt body, duplicating
    // every property in the call.
    pieces.push(source.slice(cursor, braceAt + 1));

    if (interior.includes('dpaHasRead')) {
      pieces.push(`${interior}}`);
    } else {
      const trimmed = interior.replace(/\s+$/, '');
      if (trimmed.length === 0) {
        pieces.push(`{ ${FLAGS} }`);
      } else if (trimmed.endsWith(',')) {
        pieces.push(`${trimmed} ${FLAGS}}`);
      } else {
        pieces.push(`${trimmed}, ${FLAGS}}`);
      }
      fileChanged = true;
      changedCalls += 1;
    }

    cursor = end + 1;
  }

  if (fileChanged) {
    pieces.push(source.slice(cursor));
    writeFileSync(file, pieces.join(''));
    changedFiles += 1;
  }
}

console.log(`files changed: ${changedFiles}, call sites updated: ${changedCalls}`);