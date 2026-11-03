import { DEVELOPER_DOCS, developerDocBody } from "@/lib/docs-registry";
import { LEGAL_BY_SLUG, legalBody } from "@/lib/legal-docs";
import { llmsFullTxt, type FullTextDocument } from "@/lib/llms";
import { canonicalOrigin, currentHostKind } from "@/lib/site-origin";

/**
 * /llms-full.txt — the setup guide, the FAQ and the API reference in one
 * plain-text file, from the same docs/ files their pages render, with any
 * passage that carries an unsupplied fact left out (lib/llms.ts).
 *
 * Same host rule and headers as /llms.txt: 404 on an agency's verified
 * domain, noindex everywhere.
 */
export const dynamic = "force-dynamic";

function legalDocument(slug: string): FullTextDocument | null {
  const doc = LEGAL_BY_SLUG.get(slug);
  if (!doc) return null;
  const body = legalBody(doc);
  // A placeholder is not the document; it is left out rather than published.
  return body.kind === "file" ? { title: doc.title, path: `/${doc.slug}`, markdown: body.text } : null;
}

export async function GET(): Promise<Response> {
  if ((await currentHostKind()) === "agency") {
    return new Response("Not found\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  const documents = [
    legalDocument("guide"),
    legalDocument("faq"),
    ...DEVELOPER_DOCS.map((d) => ({ title: d.title, path: d.path, markdown: developerDocBody(d).text })),
  ].filter((d): d is FullTextDocument => d !== null);
  const body = llmsFullTxt({ origin: await canonicalOrigin(), documents });
  return new Response(body, {
    headers: { "content-type": "text/plain; charset=utf-8", "x-robots-tag": "noindex" },
  });
}
