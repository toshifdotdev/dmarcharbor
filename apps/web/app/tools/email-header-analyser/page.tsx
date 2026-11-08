import type { Metadata } from "next";
import { publicMetadata } from "@/lib/seo";
import { toolBySlug } from "@/lib/tools";
import { ToolFrame } from "@/components/harbor/tools/tool-frame";
import { HeaderAnalyser } from "@/components/harbor/tools/header-analyser";

/** /tools/email-header-analyser — a free tool. Public, indexed on our own host; on an agency's domain the proxy sends it to the portal (lib/white-label.ts). */
const tool = toolBySlug("header-analyser");

export async function generateMetadata(): Promise<Metadata> {
  return publicMetadata({ title: tool.title, description: tool.description, path: tool.path });
}

export default function Page() {
  return (
    <ToolFrame
      slug="header-analyser"
      headline="Did this message pass, and where did it go?"
      lead={
        <p>
          Paste a message&rsquo;s headers to see the receiver&rsquo;s SPF, DKIM and DMARC results, whether they align with the
          From domain, and every server it passed through. Nothing leaves your browser.
        </p>
      }
    >
      <HeaderAnalyser />
    </ToolFrame>
  );
}