/**
 * Cleans untrusted text before it is stored or shown.
 *
 * DNS answers are attacker-influenced input, and a PTR or Cymru TXT record can
 * carry newlines, terminal escapes or a megabyte of padding. Iterating code
 * points rather than using a control-character regex keeps the intent obvious
 * and avoids a lint exception; C1 controls are stripped alongside C0 and DEL.
 */
export function cleanText(value: string, maxLength: number): string {
  let out = '';
  for (const char of value) {
    if (out.length >= maxLength) break;
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      continue;
    }
    out += char;
  }
  return out.trim().slice(0, maxLength);
}
