import { API_BASE, apiFetch, SLOW_API_TIMEOUT_MS } from "@/lib/api-fetch";

export const dynamic = "force-dynamic";

/**
 * The client-facing download link from the monthly report email.
 *
 * It streams the API's public download through the web origin so the recipient
 * never sees raw JSON. A bad or expired link is a plain page with one sentence,
 * not an API error body: the person clicking is an agency client, not an
 * integration developer.
 */
function errorPage(status: number, heading: string, detail: string): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${heading}</title>
</head>
<body style="margin:0;background:#f8fafc;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#0f172a;">
<main style="max-width:34rem;margin:12vh auto;padding:0 1.5rem;line-height:1.6;">
<p style="font-size:0.75rem;letter-spacing:0.12em;text-transform:uppercase;color:#64748b;margin:0 0 0.5rem;">DMARC Harbor report</p>
<h1 style="font-size:1.5rem;line-height:1.25;margin:0 0 0.75rem;">${heading}</h1>
<p style="margin:0 0 1rem;color:#334155;">${detail}</p>
<p style="margin:0;"><a href="/" style="color:#0f766e;">Return to the site</a></p>
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
    },
  });
}

export async function GET(request: Request): Promise<Response> {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  if (!token) {
    return errorPage(
      404,
      "This report link is not available",
      "It may have expired, or it may not have been copied completely. Ask the sender for a new link.",
    );
  }

  let upstream: Response;
  try {
    upstream = await apiFetch(
      `${API_BASE}/api/monthly-reports/download?token=${encodeURIComponent(token)}`,
      {
        cache: "no-store",
        credentials: "omit",
        timeoutMs: SLOW_API_TIMEOUT_MS,
        headers: { accept: "application/pdf" },
      },
    );
  } catch {
    return errorPage(
      502,
      "This report cannot be downloaded just now",
      "The service did not answer. Try again in a few minutes, or ask the sender for a new link.",
    );
  }

  if (upstream.status === 404 || upstream.status === 410) {
    return errorPage(
      404,
      "This report link is not available",
      "It may have expired, or it may not have been copied completely. Ask the sender for a new link.",
    );
  }
  if (upstream.status === 429) {
    return errorPage(
      429,
      "Too many download attempts",
      "Wait a minute and try the link again.",
    );
  }
  if (!upstream.ok || !upstream.body) {
    return errorPage(
      502,
      "This report cannot be downloaded just now",
      "The service answered with an error. Try again in a few minutes, or ask the sender for a new link.",
    );
  }

  const headers = new Headers();
  for (const name of [
    "content-type",
    "content-length",
    "content-disposition",
    "x-dmarc-pack-sha256",
    "x-dmarc-pack-reference",
  ]) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("cache-control", "no-store");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-content-type-options", "nosniff");

  return new Response(upstream.body, { status: 200, headers });
}
