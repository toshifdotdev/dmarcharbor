import type { Metadata } from "next";
import { publicMetadata } from "@/lib/seo";
import { toolBySlug } from "@/lib/tools";
import { ToolFrame } from "@/components/harbor/tools/tool-frame";
import { DkimTool } from "@/components/harbor/tools/dkim-tool";

/** /tools/dkim — a free tool. Public, indexed on our own host; on an agency's domain the proxy sends it to the portal (lib/white-label.ts). */
const tool = toolBySlug("dkim");

export async function generateMetadata(): Promise<Metadata> {
  return publicMetadata({ title: tool.title, description: tool.description, path: tool.path });
}

export default function Page() {
  return (
    <ToolFrame
      slug="dkim"
      headline="Does this selector publish a working DKIM key?"
      lead={<p>Type a domain and the selector from a message&rsquo;s DKIM-Signature header to read the key, its type and its size. Without a selector, the lookup tries the names the domain&rsquo;s services use.</p>}
    >
      <DkimTool />
    </ToolFrame>
  );
}