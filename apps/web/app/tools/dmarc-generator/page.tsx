import type { Metadata } from "next";
import { publicMetadata } from "@/lib/seo";
import { toolBySlug } from "@/lib/tools";
import { ToolFrame } from "@/components/harbor/tools/tool-frame";
import { DmarcGenerator } from "@/components/harbor/tools/dmarc-generator";

/** /tools/dmarc-generator — a free tool. Public, indexed on our own host; on an agency's domain the proxy sends it to the portal (lib/white-label.ts). */
const tool = toolBySlug("dmarc-generator");

export async function generateMetadata(): Promise<Metadata> {
  return publicMetadata({ title: tool.title, description: tool.description, path: tool.path });
}

export default function Page() {
  return (
    <ToolFrame
      slug="dmarc-generator"
      headline="Write a DMARC record to publish."
      lead={<p>Choose the policy and where reports go, and copy the TXT record. Every tag is explained as you set it. Nothing leaves your browser.</p>}
    >
      <DmarcGenerator />
    </ToolFrame>
  );
}