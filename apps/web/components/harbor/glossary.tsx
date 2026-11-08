/**
 * glossary.tsx — /glossary: the terms, drawn as the path one message takes.
 *
 * At the top, the checks in the order a receiver makes them, as one line with
 * a station per stop; each station jumps to its term. Below, the terms in
 * groups, each group one ink line with a station per term, the term's name,
 * its lighter kind, the definition, a literal example where it helps, and the
 * free tool that checks it.
 *
 * A server component with no state: anchors do the navigation. Every term id
 * is a stable anchor (lib/glossary.ts) that the tools link to.
 *
 * Test hooks: glossary-route, glossary-group (data-group), glossary-term
 * (data-term).
 */

import Link from "next/link";
import { GLOSSARY, glossaryTerm } from "@/lib/glossary";
import { FREE_TOOLS } from "@/lib/tools";
import { LinkLine } from "./tools/tool-frame";

const ROUTE = [
  { key: "header-from", name: "Header From", kind: "who it claims to be" },
  { key: "spf", name: "SPF", kind: "the sending server" },
  { key: "dkim", name: "DKIM", kind: "the signature" },
  { key: "alignment", name: "Alignment", kind: "matches the From" },
  { key: "policy", name: "Policy", kind: "none, quarantine, reject" },
  { key: "aggregate-report", name: "Reports", kind: "back to the rua address" },
];

function toolName(path: string): string | null {
  return FREE_TOOLS.find((t) => t.path === path)?.name ?? null;
}

export function GlossaryRoute() {
  return (
    <figure className="m-0" data-testid="glossary-route">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-rule pb-3">
        <span className="text-[17px] font-bold text-fg">One message, checked</span>
        <span className="text-[14px] text-fg-4">in the order a receiver checks it; each stop is a term below</span>
      </div>
      <LinkLine
        label="The checks one message passes, in order"
        className="mt-8"
        stops={ROUTE.map((r) => ({ key: r.key, name: r.name, kind: r.kind, href: `#${r.key}` }))}
      />
    </figure>
  );
}

export function GlossaryContents() {
  return (
    <nav aria-label="Glossary sections" className="flex flex-wrap gap-x-6 gap-y-2 border-y border-rule py-4">
      {GLOSSARY.map((group) => (
        <a key={group.id} href={`#group-${group.id}`} className="text-[15px] font-semibold text-fg underline decoration-rule-2 underline-offset-4 hover:decoration-fg">
          {group.name}
        </a>
      ))}
    </nav>
  );
}

export function GlossaryGroups() {
  return (
    <div className="flex flex-col gap-20">
      {GLOSSARY.map((group) => (
        <section key={group.id} id={`group-${group.id}`} aria-labelledby={`group-${group.id}-head`} data-testid="glossary-group" data-group={group.id} className="scroll-mt-6">
          <h2 id={`group-${group.id}-head`} className="text-[30px] font-[740] leading-[1.02] tracking-[-0.03em] text-fg sm:text-[40px]">
            {group.name} <span className="font-normal text-fg-4">{group.kind}</span>
          </h2>
          <ol className="m-0 mt-8 max-w-[52rem] list-none p-0">
            {group.terms.map((term, i) => {
              const last = i === group.terms.length - 1;
              const tool = term.tool ? toolName(term.tool) : null;
              const related = (term.see ?? []).map((id) => glossaryTerm(id)).filter((t) => t !== undefined);
              return (
                <li key={term.id} id={term.id} data-testid="glossary-term" data-term={term.id} className={`relative scroll-mt-6 pl-10 ${last ? "" : "pb-10"}`}>
                  {last ? null : <span aria-hidden className="absolute bottom-0 left-[7px] top-[10px] w-[5px] bg-fg" />}
                  <span aria-hidden className="absolute left-0 top-[3px] size-[19px] rounded-full border-[3px] border-fg bg-paper" />
                  <h3 className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                    <span className="text-[19px] font-bold leading-[1.3] text-fg">{term.name}</span>
                    <span className="text-[15px] text-fg-4">{term.kind}</span>
                  </h3>
                  <p className="mt-2 max-w-[44rem] text-[16px] leading-[1.55] text-fg-2">{term.definition}</p>
                  {term.example ? (
                    <p className="data mt-3 max-w-[44rem] rounded-[10px] bg-paper-3 px-3.5 py-2.5 text-[13.5px] leading-[1.55] text-fg [overflow-wrap:anywhere]">
                      {term.example}
                    </p>
                  ) : null}
                  {tool || related.length ? (
                    <p className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-[14.5px]">
                      {tool && term.tool ? (
                        <Link href={term.tool} className="link font-semibold">
                          Check it with the {tool}
                        </Link>
                      ) : null}
                      {related.length ? (
                        <span className="text-fg-4">
                          See also{" "}
                          {related.map((r, j) => (
                            <span key={r.id}>
                              {j > 0 ? ", " : ""}
                              <a href={`#${r.id}`} className="text-fg-2 underline decoration-rule-2 underline-offset-4 hover:decoration-fg">
                                {r.name}
                              </a>
                            </span>
                          ))}
                        </span>
                      ) : null}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </div>
  );
}
