/**
 * tool-frame.tsx — the page every free tool sits in: the public header, the
 * question the tool answers as its headline, the tool, the line of the other
 * tools, and the footer.
 *
 * The other tools are drawn as one line with a station each, the current one
 * an accent capsule (you are here), the way the steering file draws a route.
 * Horizontal from 900px, vertical below, and no station sits outside its box.
 */

import Link from "next/link";
import { clsx } from "clsx";
import type { ReactNode } from "react";
import { readHostBrand } from "@/lib/host-brand";
import { FREE_TOOLS, type FreeTool } from "@/lib/tools";
import { PublicFooter, PublicHeader, brandName } from "@/components/harbor/public-frame";

export async function ToolFrame({
  slug,
  headline,
  lead,
  children,
}: {
  slug: FreeTool["slug"] | null;
  headline: string;
  lead: ReactNode;
  children: ReactNode;
}) {
  const brand = await readHostBrand();
  const name = brandName(brand);
  return (
    <div data-harbor data-host-brand={brand.state}>
      <PublicHeader brand={brand} current="tools" />
      <main id="main" className="page-wrap pb-24 sm:pb-32">
        <header className="max-w-[46rem] pt-10 sm:pt-16">
          {slug ? (
            <Link href="/tools" className="link text-[14.5px] font-semibold">
              Free tools
            </Link>
          ) : null}
          <h1 className="mt-3 text-[38px] font-[760] leading-[0.96] tracking-[-0.035em] text-fg [text-wrap:balance] sm:text-[52px] min-[68.75rem]:text-[60px]">
            {headline}
          </h1>
          <div className="mt-5 max-w-[34rem] text-[17px] leading-[1.5] text-fg-2 sm:text-[19px]">{lead}</div>
        </header>

        <div className="mt-10 sm:mt-14">{children}</div>

        {slug ? (
          <section aria-labelledby="other-tools" className="mt-24 border-t border-rule pt-10 sm:mt-32">
            <h2 id="other-tools" className="text-[24px] font-[740] leading-[1.02] tracking-[-0.03em] text-fg sm:text-[30px]">
              The other free tools
            </h2>
            <ToolLine current={slug} className="mt-8" />
          </section>
        ) : null}

        <section className="mt-20 grid gap-6 border-t border-rule pt-10 min-[68.75rem]:grid-cols-[minmax(0,0.74fr)_minmax(0,1fr)] min-[68.75rem]:gap-16">
          <h2 className="text-[28px] font-[740] leading-[1.02] tracking-[-0.03em] text-fg [text-wrap:balance] sm:text-[36px]">
            One lookup is one moment.
          </h2>
          <div className="max-w-[34rem]">
            <p className="text-[17px] leading-[1.5] text-fg-2">
              DNS says what a domain asks receivers to do. Only the reports receivers send say what happened to its mail.{" "}
              {name} reads those reports for every client domain, every day, names each service sending as it, and says
              when it is safe to move to p=reject.
            </p>
            <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-3">
              <Link
                href="/sign-up"
                className="inline-flex h-[54px] items-center rounded-full bg-cta px-7 text-[16.5px] font-semibold text-cta-ink transition-colors duration-100 hover:bg-cta-hover"
              >
                Start free
              </Link>
              <Link href="/pricing" className="link text-[16px] font-semibold">
                See the plans
              </Link>
            </div>
          </div>
        </section>
      </main>
      <PublicFooter brand={brand} />
    </div>
  );
}

/**
 * The tools as one line. Each station links to its tool; the current one is
 * the accent capsule and is not a link. `current` null draws every station
 * the same (the index page lists them separately).
 */
export function ToolLine({ current, className }: { current: FreeTool["slug"] | null; className?: string }) {
  return (
    <ol className={clsx("grid min-[900px]:grid-cols-5", className)} aria-label="Free tools">
      {FREE_TOOLS.map((tool, i) => {
        const here = tool.slug === current;
        const last = i === FREE_TOOLS.length - 1;
        const label = (
          <>
            <span className={clsx("block text-[16px] font-bold", here ? "text-act" : "text-fg")}>{tool.name}</span>
            <span className="mt-0.5 block text-[14px] leading-[1.35] text-fg-4">{here ? "you are here" : tool.kind}</span>
          </>
        );
        return (
          <li key={tool.slug} className="relative pb-7 pl-10 min-[900px]:pb-0 min-[900px]:pl-0 min-[900px]:pr-6 min-[900px]:pt-9">
            {/* The line: down to the next station on phones, across to it from 900px. */}
            {last ? null : (
              <span
                aria-hidden
                className="absolute bottom-0 left-[7px] top-[10px] w-[5px] bg-fg min-[900px]:bottom-auto min-[900px]:left-[10px] min-[900px]:right-0 min-[900px]:top-[7px] min-[900px]:h-[5px] min-[900px]:w-auto"
              />
            )}
            {/* A station on every line; where you are is the longer capsule in the accent. */}
            <span
              aria-hidden
              className={clsx(
                "absolute left-0 top-0 rounded-full border-[3px] bg-paper",
                here ? "h-[30px] w-[19px] border-act min-[900px]:h-[19px] min-[900px]:w-[30px]" : "size-[19px] border-fg",
              )}
            />
            {here ? (
              <p aria-current="page">{label}</p>
            ) : (
              <Link href={tool.path} className="group block rounded-[4px]">
                <span className="block text-[16px] font-bold text-fg underline decoration-rule-2 underline-offset-4 transition-colors duration-100 group-hover:decoration-fg">
                  {tool.name}
                </span>
                <span className="mt-0.5 block text-[14px] leading-[1.35] text-fg-4">{tool.kind}</span>
              </Link>
            )}
          </li>
        );
      })}
    </ol>
  );
}
