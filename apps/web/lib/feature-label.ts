/**
 * feature-label.ts — display labels for the API's entitlement keys.
 *
 * Plan names, prices, limits and feature names are never hardcoded anywhere
 * in this app: this is a PURE TEXT TRANSFORM of the key strings the API
 * returns (reports.forensicNamed → "Reports · Forensic named"). Unknown keys
 * still render sensibly, so a new entitlement never shows as raw jargon and
 * no stale phrase can outlive the API's own naming.
 */

const EXPANSIONS: Record<string, string> = {
  sso: "SSO",
  api: "API",
  ip: "IP",
  id: "ID",
  dns: "DNS",
  spf: "SPF",
  dkim: "DKIM",
  dmarc: "DMARC",
  mta: "MTA",
  sts: "STS",
  url: "URL",
  tls: "TLS",
  ui: "UI",
  gdpr: "GDPR",
};

const WORD_FORMS: Record<string, string> = {
  whitelabel: "white-label",
};

/** "forensicNamed" → ["forensic", "named"] */
function words(token: string): string[] {
  return token.split(/(?<=[a-z0-9])(?=[A-Z])/).map((w) => w.toLowerCase());
}

function phrase(token: string): string {
  const parts = words(token).map((w) => EXPANSIONS[w] ?? WORD_FORMS[w] ?? w);
  const [first = "", ...rest] = parts;
  const head = EXPANSIONS[first] ?? first.charAt(0).toUpperCase() + first.slice(1);
  return [head, ...rest].join(" ");
}

/** "reports.forensicNamed" → "Reports" — the area a key belongs to. */
export function featureGroup(key: string): string {
  return phrase(key.split(".")[0] ?? key);
}

/** "reports.forensicNamed" → "Reports · Forensic named" */
export function featureLabel(key: string): string {
  return key.split(".").map(phrase).join(" · ");
}
