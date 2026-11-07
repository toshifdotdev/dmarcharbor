import type { Metadata } from "next";
import { publicMetadata } from "@/lib/seo";
import { toolBySlug } from "@/lib/tools";
import { ToolFrame } from "@/components/harbor/tools/tool-frame";
import { DmarcTool } from "@/components/harbor/tools/dmarc-tool";

/** /tools/dmarc — a free tool. Public, indexed on our own host; on an agency's domain the proxy sends it to the portal (lib/white-label.ts). */
const tool = toolBySlug("dmarc");

export async function generateMetadata(): Promise<Metadata> {
  return publicMetadata({ title: tool.title, description: tool.description, path: tool.path });
}

export default function Page() {
  return (
    <ToolFrame
      slug="dmarc"
      headline="What does this domain’s DMARC record tell receivers?"
      lead={<p>Type a domain to read its DMARC record from public DNS. Each tag is read aloud with what it makes a receiving mail server do, and the tags it leaves out are read too, with the default that applies.</p>}
    >
      <DmarcTool />
    </ToolFrame>
  );
}