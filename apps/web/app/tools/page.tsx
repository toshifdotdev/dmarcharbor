import type { Metadata } from "next";
import Link from "next/link";
import { publicMetadata } from "@/lib/seo";
import { FREE_TOOLS } from "@/lib/tools";
import { ToolFrame } from "@/components/harbor/tools/tool-frame";

/**
 * /tools — the free lookup tools, as one line with a station each. Public and
 * indexed on our own host; on an agency's domain the proxy sends it to the
 * portal (lib/white-label.ts VENDOR_ROUTES).
 */
export async function generateMetadata(): Promise<Metadata> {
  return publicMetadata({
    title: "Free DMARC, SPF, DKIM and BIMI tools",
    description:
      "Free lookups for email authentication: read a DMARC record tag by tag, count SPF lookups through every include, check a DKIM key or a BIMI logo, and write a DMARC record. No account.",
    path: "/tools",
  });
}

export default function ToolsPage() {
  return (
    <ToolFrame
      slug={null}
      headline="Free tools for the records that protect a domain’s mail."
      lead={
        <p>
          Each one reads public DNS the way receiving mail servers do and says what it finds in plain words. No account,
          and nothing is stored about the domains you look up.
        </p>
      }
    >
      <ol className="m-0 max-w-[52rem] list-none p-0" aria-label="Free tools">
        {FREE_TOOLS.map((tool, i) => {
          const last = i === FREE_TOOLS.length - 1;
          return (
            <li key={tool.slug} className={last ? "relative pl-12" : "relative pb-10 pl-12"}>
              {last ? null : <span aria-hidden className="absolute bottom-0 left-[9px] top-[12px] w-[7px] bg-fg" />}
              <span aria-hidden className="absolute left-0 top-[2px] size-[25px] rounded-full border-[3px] border-fg bg-paper" />
              <h2 className="text-[22px] font-[740] leading-[1.15] tracking-[-0.02em] sm:text-[26px]">
                <Link href={tool.path} className="text-fg underline decoration-rule-2 decoration-2 underline-offset-[5px] transition-colors duration-100 hover:decoration-fg">
                  {tool.name}
                </Link>{" "}
                <span className="font-normal text-fg-4">{tool.kind}</span>
              </h2>
              <p className="mt-2 max-w-[40rem] text-[16px] leading-[1.5] text-fg-2">{tool.description.replace(/ Free, no account\.$/, "")}</p>
            </li>
          );
        })}
      </ol>
      <p className="mt-10 text-[14px] text-fg-4">
        The lookups share one public scanner, limited to 20 a minute from one network so it can stay free.
      </p>
    </ToolFrame>
  );
}
