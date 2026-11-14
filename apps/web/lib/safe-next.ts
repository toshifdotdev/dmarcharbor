/**
 * A return path is only ever a same-site path: "/domains/x", never
 * "//evil.example" or "https://…". Anything else is dropped, so the sign-in
 * page cannot be used as an open redirect.
 *
 * Browsers delete tab, CR and LF from a URL before reading it, and read a
 * backslash as a slash, so "/\t/evil.example" used to pass the prefix checks
 * and then take a signed-in visitor straight to evil.example. Any control
 * character or backslash now refuses, and what remains is resolved the way the
 * browser will resolve it and kept only if it stays on this site.
 */
export function safeNext(raw: string | null | undefined): string | null {
  if (!raw || raw.length > 512) return null;
  if (raw.includes("\\") || [...raw].some((character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f)) {
    return null;
  }
  if (!raw.startsWith("/") || raw.startsWith("//")) return null;
  let url: URL;
  try {
    url = new URL(raw, "https://next.invalid");
  } catch {
    return null;
  }
  if (url.origin !== "https://next.invalid") return null;
  const path = `${url.pathname}${url.search}${url.hash}`;
  if (path.startsWith("/sign-in") || path.startsWith("/sign-up")) return null;
  return path;
}
