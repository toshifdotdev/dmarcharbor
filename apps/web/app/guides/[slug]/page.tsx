import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { guideBySlug } from "@/lib/provider-guides";
import { publicMetadata } from "@/lib/seo";
import { canonicalOrigin } from "@/lib/site-origin";
import { howToJsonLd } from "@/lib/structured-data";
import { GuideAside, GuideRecords, GuideRoute, GuideSteps } from "@/components/harbor/guides";
import { ToolFrame } from "@/components/harbor/tools/tool-frame";

/** /guides/<slug> — one provider's setup, from lib/provider-guides.ts. Unknown slugs are a 404. */

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const guide = guideBySlug((await params).slug);
  if (!guide) return {};
  return publicMetadata({ title: guide.title, description: guide.description, path: `/guides/${guide.slug}` });
}

export default async function GuidePage({ params }: { params: Promise<{ slug: string }> }) {
  const guide = guideBySlug((await params).slug);
  if (!guide) notFound();
  const structured = howToJsonLd(await canonicalOrigin(), {
    path: `/guides/${guide.slug}`,
    title: guide.title,
    description: guide.description,
    steps: guide.steps.map((s) => ({ name: s.name, text: s.text })),
    trail: [
      { name: "Setup guides", path: "/guides" },
      { name: guide.name, path: `/guides/${guide.slug}` },
    ],
  });
  return (
    <ToolFrame
      slug={null}
      structured={structured}
      crumb={{ href: "/guides", label: "Setup guides" }}
      showTools
      closingHeadline="Set up once. Watched every day."
      headline={guide.title}
      lead={<p>{guide.description}</p>}
    >
      <div className="flex flex-col gap-16">
        <GuideRoute guide={guide} />
        <div className="grid gap-x-16 gap-y-14 min-[68.75rem]:grid-cols-[minmax(0,1fr)_minmax(0,20rem)]">
          <div className="flex min-w-0 flex-col gap-14">
            <GuideRecords guide={guide} />
            <GuideSteps guide={guide} />
          </div>
          <GuideAside guide={guide} />
        </div>
      </div>
    </ToolFrame>
  );
}