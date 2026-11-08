/**
 * guides.tsx — the provider setup guides (/guides, /guides/<slug>).
 *
 * Each guide opens with the route the service's mail takes to a DMARC pass,
 * drawn in that service's own line colour (one colour, one service): from the
 * sender through the SPF and DKIM stations to the DMARC terminus. A station
 * that aligns once set up is an open station marked "after setup"; one that
 * passes for the service's own domain, and so does not count, is closed and
 * grey. Below it, the records to publish, the steps as stations on a line, and
 * what to watch for, with the provider's own pages as sources.
 *
 * Server components with no state. Records are copyable.
 *
 * Test hooks: guide-route (data-spf, data-dkim), guide-records, guide-steps,
 * guide-sources, guides-index.
 */

import Link from "next/link";
import { clsx } from "clsx";
import { CopyButton } from "@/components/ui/copy";
import { PROVIDER_GUIDES, type CheckPath, type ProviderGuide } from "@/lib/provider-guides";
import { FigureHead } from "./tools/lookup-line";

const LINE_BG: Record<ProviderGuide["line"], string> = {
  blue: "bg-route-blue",
  orange: "bg-route-orange",
  green: "bg-route-green",
  yellow: "bg-route-yellow",
  purple: "bg-route-purple",
};

const PATH_WORD: Record<CheckPath, string> = {
  aligned: "aligns",
  "after-setup": "aligns after setup",
  "not-aligned": "passes, but not for the From domain",
};

/** The route to a DMARC pass, horizontal from 900px, vertical below. */
export function GuideRoute({ guide }: { guide: ProviderGuide }) {
  const stops: Array<{ key: string; name: string; kind: string; state: "origin" | "open" | "closed" | "terminus" }> = [
    { key: "sender", name: guide.name, kind: guide.kind, state: "origin" },
    { key: "spf", name: "SPF", kind: `${PATH_WORD[guide.spf.path]}: ${guide.spf.note}`, state: guide.spf.path === "not-aligned" ? "closed" : "open" },
    { key: "dkim", name: "DKIM", kind: `${PATH_WORD[guide.dkim.path]}: ${guide.dkim.note}`, state: guide.dkim.path === "not-aligned" ? "closed" : "open" },
    { key: "dmarc", name: "DMARC pass", kind: "one aligned pass is enough", state: "terminus" },
  ];
  const line = LINE_BG[guide.line];
  return (
    <figure className="m-0" data-testid="guide-route" data-spf={guide.spf.path} data-dkim={guide.dkim.path}>
      <FigureHead name="How its mail passes DMARC" meta="one line, this service's mail" />
      <ol className="m-0 mt-8 grid list-none p-0 min-[900px]:grid-cols-4" aria-label={`How ${guide.name} mail passes DMARC`}>
        {stops.map((stop, i) => {
          const last = i === stops.length - 1;
          return (
            <li key={stop.key} className="relative pb-8 pl-10 min-[900px]:pb-0 min-[900px]:pl-0 min-[900px]:pr-6 min-[900px]:pt-10">
              {last ? null : (
                <span
                  aria-hidden
                  className={clsx(
                    "absolute bottom-0 left-[8px] top-[12px] w-[7px] min-[900px]:bottom-auto min-[900px]:left-[12px] min-[900px]:right-0 min-[900px]:top-[8px] min-[900px]:h-[7px] min-[900px]:w-auto",
                    line,
                  )}
                />
              )}
              <span
                aria-hidden
                className={clsx(
                  "absolute left-0 top-0 rounded-full border-[3px] bg-paper",
                  stop.state === "terminus" ? "h-[34px] w-[23px] border-fg min-[900px]:h-[23px] min-[900px]:w-[34px]" : "size-[23px]",
                  stop.state === "origin" && "border-fg",
                  stop.state === "open" && "border-fg",
                  stop.state === "closed" && "border-rule-2",
                )}
              />
              <p className={clsx("text-[16px] font-bold", stop.state === "closed" ? "text-fg-3" : "text-fg")}>{stop.name}</p>
              <p className="mt-0.5 max-w-[22rem] text-[14px] leading-[1.45] text-fg-4">{stop.kind}</p>
            </li>
          );
        })}
      </ol>
      <figcaption className="mt-6 max-w-[44rem] text-[15px] leading-[1.55] text-fg-2">{guide.summary}</figcaption>
    </figure>
  );
}

export function GuideRecords({ guide }: { guide: ProviderGuide }) {
  return (
    <section data-testid="guide-records" aria-labelledby="records-head">
      <FigureHead name={<span id="records-head">The records</span>} meta="copy the exact values the provider shows; these are their shapes" />
      <ul className="m-0 mt-2 list-none p-0">
        {guide.records.map((r, i) => (
          <li key={`${r.type}-${r.host}-${i}`} className="grid gap-x-6 gap-y-2 border-b border-rule py-4 last:border-b-0 min-[900px]:grid-cols-[4.5rem_minmax(0,0.8fr)_minmax(0,1.4fr)]">
            <span className="data text-[14px] font-semibold text-fg">{r.type}</span>
            <span data-copy-scope className="flex min-w-0 items-start gap-2">
              <code data-copy-value className="data min-w-0 flex-1 text-[14px] text-fg [overflow-wrap:anywhere]">
                {r.host}
              </code>
              <CopyButton value={r.host} label={`Copy the ${r.type} host`} />
            </span>
            <span className="min-w-0">
              <span data-copy-scope className="flex items-start gap-2">
                <code data-copy-value className="data min-w-0 flex-1 text-[14px] text-fg [overflow-wrap:anywhere]">
                  {r.value}
                </code>
                <CopyButton value={r.value} label={`Copy the ${r.type} value`} />
              </span>
              {r.note ? <span className="mt-1 block text-[13.5px] leading-[1.45] text-fg-4">{r.note}</span> : null}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function GuideSteps({ guide }: { guide: ProviderGuide }) {
  return (
    <section data-testid="guide-steps" aria-labelledby="steps-head">
      <FigureHead name={<span id="steps-head">The steps</span>} meta="in order" />
      <ol className="m-0 mt-6 list-none p-0">
        {guide.steps.map((step, i) => {
          const last = i === guide.steps.length - 1;
          return (
            <li key={step.name} id={`step-${i + 1}`} className={clsx("relative scroll-mt-6 pl-10", last ? "" : "pb-7")}>
              {last ? null : <span aria-hidden className="absolute bottom-0 left-[7px] top-[10px] w-[5px] bg-fg" />}
              <span aria-hidden className="absolute left-0 top-[2px] size-[19px] rounded-full border-[3px] border-fg bg-paper" />
              <p className="text-[16px] font-bold leading-[1.4] text-fg">
                <span className="tnum mr-2 font-semibold text-fg-4">{i + 1}</span>
                {step.name}
              </p>
              <p className="mt-1 max-w-[44rem] text-[15.5px] leading-[1.55] text-fg-2">{step.text}</p>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

export function GuideAside({ guide }: { guide: ProviderGuide }) {
  return (
    <aside className="flex flex-col gap-10">
      {guide.pitfalls.length ? (
        <div>
          <FigureHead name="Watch for" />
          <ul className="m-0 mt-4 flex list-none flex-col gap-3 p-0">
            {guide.pitfalls.map((p) => (
              <li key={p} className="border-l-[3px] border-warn-mark pl-3 text-[14.5px] leading-[1.5] text-fg-2">
                {p}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div>
        <FigureHead name="Check it" meta="free, no account" />
        <ul className="m-0 mt-4 flex list-none flex-col gap-2 p-0 text-[15px]">
          <li>
            <Link href="/tools/spf" className="link font-semibold">
              SPF lookup
            </Link>{" "}
            <span className="text-fg-4">counts the lookups the include adds</span>
          </li>
          <li>
            <Link href="/tools/dkim" className="link font-semibold">
              DKIM lookup
            </Link>{" "}
            <span className="text-fg-4">reads the key at the selector</span>
          </li>
          <li>
            <Link href="/tools/dmarc" className="link font-semibold">
              DMARC lookup
            </Link>{" "}
            <span className="text-fg-4">reads the policy and report address</span>
          </li>
          <li>
            <Link href="/glossary#alignment" className="link font-semibold">
              Alignment
            </Link>{" "}
            <span className="text-fg-4">in the glossary</span>
          </li>
        </ul>
      </div>
      <div data-testid="guide-sources">
        <FigureHead name="Sources" meta={`checked ${guide.checkedOn}`} />
        <ul className="m-0 mt-4 flex list-none flex-col gap-2 p-0 text-[14.5px]">
          {guide.sources.map((s) => (
            <li key={s.url}>
              <a href={s.url} className="link" rel="noopener noreferrer" target="_blank">
                {s.label}
              </a>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-[13.5px] leading-[1.5] text-fg-4">
          Providers change their screens. Where a step here and the provider&rsquo;s console disagree, follow the console.
        </p>
      </div>
    </aside>
  );
}

/** The guides as two lines: mailbox hosts, then the services that send for them. */
export function GuidesIndex() {
  const groups = [
    { key: "mailbox", name: "Mailbox hosts", kind: "where staff mail comes from" },
    { key: "sender", name: "Sending services", kind: "newsletters, marketing and app mail" },
  ] as const;
  return (
    <div className="flex flex-col gap-16" data-testid="guides-index">
      {groups.map((group) => (
        <section key={group.key} aria-labelledby={`g-${group.key}`}>
          <h2 id={`g-${group.key}`} className="text-[28px] font-[740] leading-[1.02] tracking-[-0.03em] text-fg sm:text-[36px]">
            {group.name} <span className="font-normal text-fg-4">{group.kind}</span>
          </h2>
          <ol className="m-0 mt-8 grid list-none gap-x-10 gap-y-8 p-0 min-[900px]:grid-cols-2">
            {PROVIDER_GUIDES.filter((g) => g.group === group.key).map((g) => (
              <li key={g.slug} className="flex gap-4">
                <span aria-hidden className={clsx("mt-[9px] h-[7px] w-10 shrink-0 rounded-full", LINE_BG[g.line])} />
                <div className="min-w-0">
                  <h3 className="text-[19px] font-bold leading-[1.3]">
                    <Link href={`/guides/${g.slug}`} className="text-fg underline decoration-rule-2 decoration-2 underline-offset-[5px] hover:decoration-fg">
                      {g.name}
                    </Link>{" "}
                    <span className="font-normal text-fg-4">{g.kind}</span>
                  </h3>
                  <p className="mt-1.5 text-[15px] leading-[1.5] text-fg-2">{g.summary}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}
