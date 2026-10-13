/**
 * structured-data-view.tsx — emits a JSON-LD block.
 *
 * A SERVER component: it needs the request's CSP nonce, which comes from
 * `x-nonce`, a header the proxy stamps on every request.
 *
 * The nonce is not optional. The Content-Security-Policy is
 * `script-src 'self' 'nonce-...' 'strict-dynamic'` with no `'unsafe-inline'`,
 * and CSP governs every inline script element — a `<script
 * type="application/ld+json">` is still a script element, so without the nonce
 * the browser drops it and the markup never reaches a crawler. It would fail
 * silently, which is the reason to be explicit about it here.
 */

import { headers } from "next/headers";
import { jsonLdString } from "@/lib/structured-data";

export async function StructuredData({ data }: { data: Record<string, unknown> }) {
  let nonce: string | undefined;
  try {
    const h = await headers();
    nonce = h.get("x-nonce") ?? undefined;
  } catch {
    // Outside a request context there is no nonce to add. Rendering without one
    // is better than not rendering: the block is either dropped by a strict CSP
    // or read by a crawler that is not enforcing one.
    nonce = undefined;
  }

  return (
    <script
      type="application/ld+json"
      nonce={nonce}
      dangerouslySetInnerHTML={{ __html: jsonLdString(data) }}
    />
  );
}
