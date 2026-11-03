import { securityTxt } from "@/lib/crawl-policy";
import { canonicalOrigin, currentHostKind } from "@/lib/site-origin";

/**
 * /.well-known/security.txt (RFC 9116): where to report a vulnerability in
 * this product. The fields are built in lib/crawl-policy.ts securityTxt and
 * point at our canonical origin (SITE_URL), whichever of our hosts served it.
 *
 * Not served on an agency's verified domain (404): the file speaks for the
 * operator of the site, and on that domain the reader's site is the agency's.
 *
 * Per request, because Expires is counted from now.
 */
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  if ((await currentHostKind()) === "agency") {
    return new Response("Not found\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  const body = securityTxt({ origin: await canonicalOrigin(), now: new Date() });
  // No shared-cache header: the answer differs by host (a 404 on an agency's
  // domain), and a cache keyed on the path alone would hand one host's to another.
  return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } });
}
