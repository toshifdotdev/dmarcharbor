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
import type { CSSProperties, ReactNode } from "react";
import { readHostBrand } from "@/lib/host-brand";
import { canonicalOrigin } from "@/lib/site-origin";
import { toolJsonLd, toolsIndexJsonLd } from "@/lib/structured-data";
import { FREE_TOOLS, TOOLS_INDEX, toolBySlug, type FreeTool } from "@/lib/tools";
import { StructuredData } from "@/components/structured-data-view";
import { PublicFooter, PublicHeader, brandName } from "@/components/harbor/public-frame";

export async function ToolFrame({
  slug,
  headline,
  lead,
  children,
  structured,
  crumb,
  showTools,
  closingHeadline = "One lookup is one moment.",
}: {
  slug: FreeTool["slug"] | null;
  headline: string;
  lead: ReactNode;
  children: ReactNode;
  /** JSON-LD for a page that is not a tool (the glossary, a guide). */
  structured?: Record<string, unknown>;
  /** The link above the headline. Defaults to Free tools on a tool page. */
  crumb?: { href: string; label: string } | null;
  /** The line of free tools below the page. Defaults to on for a tool. */
  showTools?: boolean;
  closingHeadline?: string;
}) {
  const [brand, origin] = await Promise.all([readHostBrand(), canonicalOrigin()]);
  const name = brandName(brand);
  // Each tool is a free WebApplication under Free tools; the index lists them.
  const data = structured ?? (slug ? toolJsonLd(origin, toolBySlug(slug)) : toolsIndexJsonLd(origin, { ...TOOLS_INDEX, tools: FREE_TOOLS }));
  const above = crumb === undefined ? (slug ? { href: "/tools", label: "Free tools" } : null) : crumb;
  const toolsLine = showTools ?? Boolean(slug);
  return (
    <div data-harbor data-host-brand={brand.state}>
      <StructuredData data={data} />
      <PublicHeader brand={brand} current="tools" />
      <main id="main" className="page-wrap pb-24 sm:pb-32">
        <header className="max-w-[46rem] pt-10 sm:pt-16">
          {above ? (
            <Link href={above.href} className="link text-[14.5px] font-semibold">
              {above.label}
            </Link>
          ) : null}
          <h1 className="mt-3 text-[38px] font-[760] leading-[0.96] tracking-[-0.035em] text-fg [text-wrap:balance] sm:text-[52px] min-[68.75rem]:text-[60px]">
            {headline}
          </h1>
          <div className="mt-5 max-w-[34rem] text-[17px] leading-[1.5] text-fg-2 sm:text-[19px]">{lead}</div>
          {slug ? (
            <p className="mt-3 text-[14.5px] text-fg-4">
              A term you do not know?{" "}
              <Link href="/glossary" className="link font-semibold">
                The glossary
              </Link>{" "}
              explains each one.
            </p>
          ) : null}
        </header>

        <div className="mt-10 sm:mt-14">{children}</div>

        {toolsLine ? (
          <section aria-labelledby="other-tools" className="mt-24 border-t border-rule pt-10 sm:mt-32">
            <h2 id="other-tools" className="text-[24px] font-[740] leading-[1.02] tracking-[-0.03em] text-fg sm:text-[30px]">
              {slug ? "The other free tools" : "The free tools"}
            </h2>
            <ToolLine current={slug} className="mt-8" />
          </section>
        ) : null}

        <section className="mt-20 grid gap-6 border-t border-rule pt-10 min-[68.75rem]:grid-cols-[minmax(0,0.74fr)_minmax(0,1fr)] min-[68.75rem]:gap-16">
          <h2 className="text-[28px] font-[740] leading-[1.02] tracking-[-0.03em] text-fg [text-wrap:balance] sm:text-[36px]">
            {closingHeadline}
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

/** The tools as one line, the current one marked "you are here". */
export function ToolLine({ current, className }: { current: FreeTool["slug"] | null; className?: string }) {
  return (
    <LinkLine
      label="Free tools"
      className={className}
      stops={FREE_TOOLS.map((tool) => ({ key: tool.slug, name: tool.name, kind: tool.kind, href: tool.path, here: tool.slug === current }))}
    />
  );
}

/**
 * Stops on one line, each a link. The current one is the accent capsule and
 * not a link. Horizontal from 900px with one column per stop, vertical below,
 * and no station sits outside its box.
 */
export function LinkLine({
  label,
  stops,
  className,
}: {
  label: string;
  stops: Array<{ key: string; name: string; kind: string; href: string; here?: boolean }>;
  className?: string;
}) {
  return (
    <ol
      className={clsx("grid min-[900px]:[grid-template-columns:repeat(var(--n),minmax(0,1fr))]", className)}
      style={{ "--n": stops.length } as CSSProperties}
      aria-label={label}
    >
      {stops.map((stop, i) => {
        const here = Boolean(stop.here);
        const last = i === stops.length - 1;
        return (
          <li key={stop.key} className="relative pb-7 pl-10 min-[900px]:pb-0 min-[900px]:pl-0 min-[900px]:pr-6 min-[900px]:pt-9">
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
              <p aria-current="page">
                <span className="block text-[16px] font-bold text-act">{stop.name}</span>
                <span className="mt-0.5 block text-[14px] leading-[1.35] text-fg-4">you are here</span>
              </p>
            ) : (
              <Link href={stop.href} className="group block rounded-[4px]">
                <span className="block text-[16px] font-bold text-fg underline decoration-rule-2 underline-offset-4 transition-colors duration-100 group-hover:decoration-fg">
                  {stop.name}
                </span>
                <span className="mt-0.5 block text-[14px] leading-[1.35] text-fg-4">{stop.kind}</span>
              </Link>
            )}
          </li>
        );
      })}
    </ol>
  );
}