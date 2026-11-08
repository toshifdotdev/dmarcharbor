import type { Metadata } from "next";
import { publicMetadata } from "@/lib/seo";
import { toolBySlug } from "@/lib/tools";
import { ToolFrame } from "@/components/harbor/tools/tool-frame";
import { ReportReader } from "@/components/harbor/tools/report-reader";

/** /tools/dmarc-report-reader — a free tool. Public, indexed on our own host; on an agency's domain the proxy sends it to the portal (lib/white-label.ts). */
const tool = toolBySlug("report-reader");

export async function generateMetadata(): Promise<Metadata> {
  return publicMetadata({ title: tool.title, description: tool.description, path: tool.path });
}

export default function Page() {
  return (
    <ToolFrame
      slug="report-reader"
      headline="What does this DMARC report say?"
      lead={
        <p>
          Drop the XML a receiver sent, or the .zip or .xml.gz it came in, and read it as a map of who sent as the domain and
          a table of every row. The file stays on your computer.
        </p>
      }
    >
      <ReportReader />
    </ToolFrame>
  );
}