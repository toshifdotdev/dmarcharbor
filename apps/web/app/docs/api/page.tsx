import type { Metadata } from "next";
import { DeveloperDocument } from "@/components/harbor/legal-document";
import { developerDoc } from "@/lib/docs-registry";
import { requestOrigin } from "@/lib/metadata-origin";
import { publicMetadata } from "@/lib/seo";

/**
 * /docs/api — the /api/v1 reference. Public, loads signed out, indexed.
 *
 * The body is docs/API.md, rendered in the same reading frame as the legal
 * documents and the setup guide: a contents rail, a link on every section and
 * endpoint, code examples that copy exactly, and a print layout.
 */
export async function generateMetadata(): Promise<Metadata> {
  const doc = developerDoc("api");
  return publicMetadata({
    title: doc?.title ?? "API reference",
    description: doc?.summary ?? "The /api/v1 reference.",
    path: doc?.path ?? "/docs/api",
    origin: await requestOrigin(),
  });
}

export default function Page() {
  return <DeveloperDocument slug="api" />;
}
