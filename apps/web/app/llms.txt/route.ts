import { getPlanCatalog } from "@/lib/api-ops";
import { llmsTxt } from "@/lib/llms";
import { canonicalOrigin, currentHostKind } from "@/lib/site-origin";
import type { PlanDefinition } from "@/lib/types";

/**
 * /llms.txt — the plain-text index of this site for AI assistants
 * (lib/llms.ts builds it; tests/llms.test.ts checks it).
 *
 * Links name the canonical origin, whichever of our hosts served it. Not
 * served on an agency's verified domain (404): every page it lists redirects
 * to the portal there, and the file describes us, not the agency.
 *
 * The plans come from GET /api/plans, the same catalogue the pricing page
 * reads, so the file never states a price the page does not. A failed read
 * leaves the section pointing at /pricing instead of guessing.
 *
 * X-Robots-Tag: noindex keeps the file itself out of search results; it is
 * for reading, and robots.txt lets every crawler fetch it.
 */
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  if ((await currentHostKind()) === "agency") {
    return new Response("Not found\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  const catalog = await getPlanCatalog().catch(() => null);
  const plans = catalog
    ? catalog.order
        .map((tier) => catalog.plans.find((p) => p.tier === tier))
        .filter((p): p is PlanDefinition => Boolean(p))
    : null;
  const body = llmsTxt({ origin: await canonicalOrigin(), plans });
  // No shared-cache header: the answer differs by host.
  return new Response(body, {
    headers: { "content-type": "text/plain; charset=utf-8", "x-robots-tag": "noindex" },
  });
}
