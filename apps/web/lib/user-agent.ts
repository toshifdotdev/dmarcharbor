/**
 * user-agent.ts — a session's user-agent string as a device a person would
 * recognise: "Chrome on Windows", "Safari on iPhone".
 *
 * Read from the string the browser sent, nothing else, so it is a description
 * and not an identification: the raw string stays available beside it. An
 * empty or unrecognised string says so rather than guessing.
 */

const BROWSERS: Array<[RegExp, string]> = [
  [/Edg(?:e|A|iOS)?\//, "Edge"],
  [/OPR\/|Opera/, "Opera"],
  [/Firefox\/|FxiOS\//, "Firefox"],
  [/SamsungBrowser\//, "Samsung Internet"],
  [/CriOS\/|Chrome\//, "Chrome"],
  [/Version\/[\d.]+.*Safari\//, "Safari"],
  [/curl\//i, "curl"],
  [/node|undici|axios|python-requests|okhttp/i, "a script"],
];

const SYSTEMS: Array<[RegExp, string]> = [
  [/iPhone/, "iPhone"],
  [/iPad/, "iPad"],
  [/Android/, "Android"],
  [/Windows NT/, "Windows"],
  [/Mac OS X|Macintosh/, "macOS"],
  [/CrOS/, "ChromeOS"],
  [/Linux/, "Linux"],
];

export function deviceLabel(userAgent: string | null | undefined): string {
  if (!userAgent || !userAgent.trim()) return "Device not reported";
  const browser = BROWSERS.find(([re]) => re.test(userAgent))?.[1];
  const system = SYSTEMS.find(([re]) => re.test(userAgent))?.[1];
  if (browser && system) return `${browser} on ${system}`;
  if (browser) return browser;
  if (system) return `A browser on ${system}`;
  return "Unrecognised device";
}
