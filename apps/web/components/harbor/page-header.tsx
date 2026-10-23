/**
 * page-header.tsx — breadcrumb, title, the one-line answer, and actions.
 *
 * The breadcrumb carries the hierarchy below the workspace (client, domain), so
 * an operator three levels deep can say where they are without the rail. The
 * last crumb is the page itself and is not a link.
 */

import Link from "next/link";
import { clsx } from "clsx";
import type { ReactNode } from "react";
import { ChevronRight } from "@/components/ui/icons";

export function Breadcrumbs({ items }: { items: Array<{ label: ReactNode; href?: string; mono?: boolean }> }) {
  return (
    <nav aria-label="Breadcrumb">
      <ol className="flex flex-wrap items-center gap-1 text-meta text-fg-3">
        {items.map((item, i) => {
          const last = i === items.length - 1;
          return (
            <li key={i} className="flex items-center gap-1">
              {item.href && !last ? (
                <Link href={item.href} className={clsx("font-medium hover:text-fg hover:underline", item.mono && "data")}>
                  {item.label}
                </Link>
              ) : (
                <span aria-current={last ? "page" : undefined} className={clsx("font-medium", last && "text-fg-2", item.mono && "data")}>
                  {item.label}
                </span>
              )}
              {!last ? <ChevronRight size={12} className="text-fg-4" /> : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

export function PageHeader({
  crumbs,
  title,
  titleMono,
  status,
  lede,
  meta,
  actions,
}: {
  crumbs?: Array<{ label: ReactNode; href?: string; mono?: boolean }>;
  title: ReactNode;
  /** Domains are identifiers: set in the data face, not as a heading word. */
  titleMono?: boolean;
  status?: ReactNode;
  lede?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-2">
      {crumbs ? <Breadcrumbs items={crumbs} /> : null}
      <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
        <div className="min-w-[min(100%,28rem)] flex-1">
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <h1
              className={clsx(
                "min-w-0 break-words font-bold tracking-[-0.02em] text-fg",
                titleMono ? "data text-[22px] leading-[28px] font-semibold tracking-[-0.03em] sm:text-h1" : "wide text-h1",
              )}
            >
              {title}
            </h1>
            {status}
          </div>
          {lede ? <p className="mt-1.5 max-w-[80ch] text-body text-fg-2">{lede}</p> : null}
          {meta ? <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-meta text-fg-3">{meta}</div> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
    </header>
  );
}

/** A section heading inside a page: a legend-sized title with a rule. */
export function SectionHead({
  title,
  aside,
  id,
  className,
}: {
  title: ReactNode;
  aside?: ReactNode;
  id?: string;
  className?: string;
}) {
  return (
    <div className={clsx("flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 pb-2", className)}>
      <h2 id={id} className="text-h3 font-bold tracking-[-0.01em] text-fg">
        {title}
      </h2>
      {aside ? <div className="text-meta text-fg-3">{aside}</div> : null}
    </div>
  );
}
