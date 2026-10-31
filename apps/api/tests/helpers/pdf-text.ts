/**
 * Pulls the visible text back out of a PDF that pdfkit wrote uncompressed.
 *
 * pdfkit writes each run of text as a `[<hex> kern <hex>] TJ` operator under a
 * `/Fn size Tf` font selection. What the hex means depends on the font:
 *
 *   - a standard font (Helvetica, Courier) encodes one byte per character in
 *     WinAnsi, which reads back as latin1;
 *   - an embedded font (Albert Sans, Atkinson Hyperlegible Mono) encodes two
 *     bytes per glyph, as glyph ids in its own subset, and writes a ToUnicode
 *     map that says which characters each glyph stands for.
 *
 * So the text is decoded font by font: the resource name in Tf is resolved to
 * its font object, the font's ToUnicode stream is parsed, and each glyph id is
 * mapped back. A font with no ToUnicode is read as latin1, which is the
 * standard-face fallback.
 *
 * Kerned runs arrive as several hex strings in one TJ; they are joined without
 * a space. Separate TJ operators (lines, cells) are joined with a space.
 */

type CMap = Map<number, string>;

function objectStart(raw: string, position: number): number | null {
  const pattern = /(\d+) 0 obj/g;
  let found: number | null = null;
  let match = pattern.exec(raw);
  while (match !== null && match.index < position) {
    found = Number(match[1]);
    match = pattern.exec(raw);
  }
  return found;
}

function streamOf(raw: string, objectNumber: number): string | null {
  const header = new RegExp(`(?:^|\\n)${objectNumber} 0 obj`, 'g');
  const match = header.exec(raw);
  if (!match) return null;
  const start = raw.indexOf('stream', match.index);
  const end = raw.indexOf('endstream', start);
  if (start < 0 || end < 0) return null;
  return raw.slice(start + 'stream'.length, end);
}

function decodeUnits(hex: string): string {
  const units: number[] = [];
  for (const part of hex.trim().split(/\s+/)) {
    for (let i = 0; i + 4 <= part.length; i += 4) {
      units.push(parseInt(part.slice(i, i + 4), 16));
    }
  }
  return String.fromCharCode(...units);
}

function parseCMap(stream: string): CMap {
  const map: CMap = new Map();
  const ranges = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*\[([^\]]*)\]/g;
  let range = ranges.exec(stream);
  while (range !== null) {
    const start = parseInt(range[1]!, 16);
    const entries = range[3]!.match(/<([0-9a-fA-F\s]*)>/g) ?? [];
    entries.forEach((entry, index) => {
      map.set(start + index, decodeUnits(entry.slice(1, -1)));
    });
    range = ranges.exec(stream);
  }
  return map;
}

export function extractPdfText(buffer: Buffer): string {
  const raw = buffer.toString('latin1');

  // Font object number -> its ToUnicode map.
  const cmapsByFontObject = new Map<number, CMap>();
  const toUnicode = /\/ToUnicode (\d+) 0 R/g;
  let tu = toUnicode.exec(raw);
  while (tu !== null) {
    const fontObject = objectStart(raw, tu.index);
    const stream = streamOf(raw, Number(tu[1]));
    if (fontObject !== null && stream) cmapsByFontObject.set(fontObject, parseCMap(stream));
    tu = toUnicode.exec(raw);
  }

  // Resource name (F1, F2...) -> font object number. pdfkit names fonts once per
  // document, so the mapping is the same on every page.
  const fontByName = new Map<string, number>();
  const resource = /\/(F\d+) (\d+) 0 R/g;
  let res = resource.exec(raw);
  while (res !== null) {
    fontByName.set(res[1]!, Number(res[2]));
    res = resource.exec(raw);
  }

  const parts: string[] = [];
  let current: CMap | null = null;
  // A TJ array holds only hex strings and numbers, never a bracket, so a plain
  // character class finds it in linear time. (A nested quantifier here backtracks
  // exponentially on the 256-entry arrays in a ToUnicode map, which also start
  // with "[" but are not followed by TJ.)
  const ops = /\/(F\d+) [\d.]+ Tf|\[([^[\]]*)\] TJ/g;
  let op = ops.exec(raw);
  while (op !== null) {
    if (op[1]) {
      const object = fontByName.get(op[1]);
      current = object !== undefined ? (cmapsByFontObject.get(object) ?? null) : null;
    } else if (op[2]) {
      const hexes = op[2].match(/<([0-9a-fA-F]*)>/g) ?? [];
      const text = hexes
        .map((h) => {
          const hex = h.slice(1, -1);
          if (current) {
            let out = '';
            for (let i = 0; i + 4 <= hex.length; i += 4) out += current.get(parseInt(hex.slice(i, i + 4), 16)) ?? '';
            return out;
          }
          return hex.length % 2 === 0 ? Buffer.from(hex, 'hex').toString('latin1') : '';
        })
        .join('');
      parts.push(text);
    }
    op = ops.exec(raw);
  }

  return parts.join(' ');
}

/**
 * pdfkit emits kerned runs and wraps lines, so a phrase can arrive split by
 * an adjustment or a line break. Comparing without whitespace is the reliable
 * way to assert on a phrase.
 */
export function normalisePdfText(value: string): string {
  return value.replace(/\s+/g, '').toLowerCase();
}
