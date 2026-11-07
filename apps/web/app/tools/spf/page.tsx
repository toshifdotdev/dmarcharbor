import type { Metadata } from "next";
import { publicMetadata } from "@/lib/seo";
import { toolBySlug } from "@/lib/tools";
import { ToolFrame } from "@/components/harbor/tools/tool-frame";
import { SpfTool } from "@/components/harbor/tools/spf-tool";

/** /tools/spf — a free tool. Public, indexed on our own host; on an agency's domain the proxy sends it to the portal (lib/white-label.ts). */
const tool = toolBySlug("spf");

export async function generateMetadata(): Promise<Metadata> {
  return publicMetadata({ title: tool.title, description: tool.description, path: tool.path });
}

export default function Page() {
  return (
    <ToolFrame
      slug="spf"
      headline="How many DNS lookups does this SPF record cost?"
      lead={<p>Receivers stop after 10 DNS lookups and fail SPF. Type a domain to follow every include the way they do, and see which service spends the lookups.</p>}
    >
      <SpfTool />
    </ToolFrame>
  );
}