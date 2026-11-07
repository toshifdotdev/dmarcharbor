import type { Metadata } from "next";
import { publicMetadata } from "@/lib/seo";
import { toolBySlug } from "@/lib/tools";
import { ToolFrame } from "@/components/harbor/tools/tool-frame";
import { BimiTool } from "@/components/harbor/tools/bimi-tool";

/** /tools/bimi — a free tool. Public, indexed on our own host; on an agency's domain the proxy sends it to the portal (lib/white-label.ts). */
const tool = toolBySlug("bimi");

export async function generateMetadata(): Promise<Metadata> {
  return publicMetadata({ title: tool.title, description: tool.description, path: tool.path });
}

export default function Page() {
  return (
    <ToolFrame
      slug="bimi"
      headline="Can this domain’s logo show beside its mail?"
      lead={<p>Type a domain to check its BIMI record, its DMARC policy, its logo file against the SVG Tiny PS rules, and whether a certificate is named.</p>}
    >
      <BimiTool />
    </ToolFrame>
  );
}