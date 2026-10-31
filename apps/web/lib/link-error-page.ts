/**
 * link-error-page.ts — the plain page a route handler answers with when an
 * emailed link cannot hand over its file (a monthly report, a data export).
 *
 * A route handler cannot render the React frames, and the reader clicked a
 * link in an email, so raw JSON or a bare status line is the worst possible
 * answer. This is the Routes look spelled out inline: white ground, ink type,
 * the host's name in the masthead, one sentence of what happened and one of
 * what to do. A link that no longer serves anything is drawn as a line ending
 * at a closed station; a failure to load has no drawing, so the two never
 * read alike.
 *
 * The name follows the host rule (lib/host-brand.ts): the agency's only on its
 * verified domain, ours everywhere else, never an unverified agency name.
 * Every interpolated value is HTML-escaped: the agency name is tenant data.
 */

import { contrastInk, HEX } from "./brand-vars";
import { DEFAULT_BRAND, readHostBrand } from "./host-brand";

export interface LinkPageAction {
  href: string;
  label: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const CLOSED_LINE = `<svg width="168" height="30" viewBox="0 0 168 30" aria-hidden="true" style="display:block;margin:0 0 32px">
<path d="M12 15H146" stroke="#c9cdd4" stroke-width="5" stroke-linecap="round" stroke-dasharray="0.1 10" fill="none"/>
<path d="M12 15H92" stroke="#15171b" stroke-width="5" stroke-linecap="round" fill="none"/>
<circle cx="12" cy="15" r="7" fill="#ffffff" stroke="#15171b" stroke-width="3"/>
<rect x="146" y="3" width="16" height="24" rx="8" fill="#ffffff" stroke="#c9cdd4" stroke-width="3"/>
</svg>`;

export async function linkErrorPage({
  status,
  kind,
  heading,
  detail,
  closed = false,
  actions = [],
  headers: extraHeaders,
}: {
  status: number;
  /** What the link was for, beside the name: "Monthly report". */
  kind: string;
  heading: string;
  detail: string;
  /** The link no longer serves anything (expired, revoked, unknown). */
  closed?: boolean;
  /** The first is the primary pill; the rest are text links. */
  actions?: LinkPageAction[];
  headers?: Record<string, string>;
}): Promise<Response> {
  const brand = await readHostBrand();
  const verified = brand.state === "verified";
  const name = verified ? brand.workspaceName : DEFAULT_BRAND.workspaceName;
  // Ink for our own brand; the tenant's primary on its verified domain, with
  // the ink chosen for contrast, as BrandApplier does for the React pages.
  const primary = verified && brand.primaryColor && HEX.test(brand.primaryColor) ? brand.primaryColor : "#15171b";
  const onPrimary = primary === "#15171b" ? "#ffffff" : contrastInk(primary);

  const links = actions
    .map((action, i) =>
      i === 0
        ? `<a href="${escapeHtml(action.href)}" style="display:inline-flex;align-items:center;height:44px;padding:0 22px;border-radius:999px;background:${primary};color:${onPrimary};font-size:15px;font-weight:650;text-decoration:none">${escapeHtml(action.label)}</a>`
        : `<a href="${escapeHtml(action.href)}" style="color:#15171b;font-size:16px;font-weight:600;text-decoration:underline;text-underline-offset:3px">${escapeHtml(action.label)}</a>`,
    )
    .join("");

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(heading)} · ${escapeHtml(name)}</title>
</head>
<body style="margin:0;background:#ffffff;color:#15171b;font-family:'Albert Sans',system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;">
<header style="max-width:1320px;margin:0 auto;padding:0 24px;box-sizing:border-box;">
<p style="margin:0;min-height:72px;display:flex;align-items:center;gap:10px;font-size:17px;"><strong style="font-weight:700;letter-spacing:-0.01em">${escapeHtml(name)}</strong><span style="color:#6c717a">${escapeHtml(kind)}</span></p>
<div style="border-top:1px solid #e7e9ed"></div>
</header>
<main style="max-width:1320px;margin:0 auto;padding:12vh 24px 96px;box-sizing:border-box;">
<div style="max-width:40rem">
${closed ? CLOSED_LINE : ""}
<h1 style="margin:0;font-size:clamp(32px,6vw,46px);font-weight:760;line-height:1.02;letter-spacing:-0.035em;text-wrap:balance">${escapeHtml(heading)}</h1>
<p style="margin:20px 0 0;max-width:34rem;font-size:18px;line-height:1.5;color:#41454d">${escapeHtml(detail)}</p>
${links ? `<p style="margin:32px 0 0;display:flex;flex-wrap:wrap;align-items:center;gap:16px 24px">${links}</p>` : ""}
</div>
</main>
</body>
</html>`;

  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex, nofollow",
      ...extraHeaders,
    },
  });
}
