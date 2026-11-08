import type { Metadata } from "next";
import { GUIDES_INDEX, PROVIDER_GUIDES } from "@/lib/provider-guides";
import { publicMetadata } from "@/lib/seo";
import { canonicalOrigin } from "@/lib/site-origin";
import { breadcrumbJsonLd, graph } from "@/lib/structured-data";
import { GuidesIndex } from "@/components/harbor/guides";
import { ToolFrame } from "@/components/harbor/tools/tool-frame";

/**
 * /guides — SPF, DKIM and DMARC setup by provider. Public and indexed on our
 * own host; on an agency's domain the proxy sends it to the portal
 * (lib/white-label.ts VENDOR_ROUTES).
 */
export async function generateMetadata(): Promise<Metadata> {
  return publicMetadata({ title: GUIDES_INDEX.title, description: GUIDES_INDEX.description, path: GUIDES_INDEX.path });
}

export default async function GuidesPage() {
  const origin = await canonicalOrigin();
  const page = new URL(GUIDES_INDEX.path, origin).toString();
  const structured = graph([
    {
      "@type": "CollectionPage",
      "@id": `${page}#page`,
      name: GUIDES_INDEX.title,
      description: GUIDES_INDEX.description,
      url: page,
      inLanguage: "en",
      mainEntity: {
        "@type": "ItemList",
        itemListElement: PROVIDER_GUIDES.map((g, i) => ({
          "@type": "ListItem",
          position: i + 1,
          name: g.title,
          url: new URL(`/guides/${g.slug}`, origin).toString(),
        })),
      },
    },
    breadcrumbJsonLd(origin, [{ name: "Setup guides", path: GUIDES_INDEX.path }]),
  ]);
  return (
    <ToolFrame
      slug={null}
      structured={structured}
      crumb={{ href: "/tools", label: "Free tools" }}
      showTools
      closingHeadline="Set up once. Watched every day."
      headline="SPF, DKIM and DMARC, provider by provider."
      lead={
        <p>
          The records each service needs and where to find them, checked against the provider&rsquo;s own pages. Each
          guide starts with how that service&rsquo;s mail passes DMARC, because that decides which records matter.
        </p>
      }
    >
      <GuidesIndex />
    </ToolFrame>
  );
}