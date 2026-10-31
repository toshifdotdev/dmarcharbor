"use client";

/**
 * directory.tsx — the settings index: every section, found by what you need
 * to do.
 *
 * Drawn as four lines, one per group, with a station for each section: the
 * same picture as the rail beside every section, at reading size. The search
 * reads the same task phrases Jump does ("sign out a lost laptop", "delete a
 * client's personal data"), so a person who does not know a section is called
 * Erasure still lands on it. Each stop says who can change it, and whether
 * that includes you, before you open it.
 */

import Link from "next/link";
import { useMemo, useState } from "react";
import { mayChange, SETTINGS_GROUPS, type SettingsSection, type Who } from "@/lib/settings-map";
import { SearchInput } from "@/components/ui/field";
import { ArrowRight } from "@/components/ui/icons";
import { PermanentMark, StateMark } from "./parts";

const WHO_LABEL: Record<Who, string> = {
  anyone: "Every member",
  admin: "Owners and admins",
  owner: "Owner only",
};

function match(s: SettingsSection, q: string): string | null | false {
  if (!q) return null;
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hay = (t: string) => words.every((w) => t.toLowerCase().includes(w));
  const task = s.tasks.find(hay);
  if (task) return task;
  if (hay(`${s.label} ${s.does} ${s.key}`)) return null;
  return false;
}

function WhoCan({ who, can }: { who: Who; can: boolean | null }) {
  const readOnly = who !== "anyone" && can === false;
  return (
    <span className="inline-flex items-center gap-1.5 text-meta">
      <StateMark shape={readOnly ? "closed" : "open"} tone="ink" size={9} />
      <span className="font-semibold text-fg-2">{WHO_LABEL[who]}</span>
      {readOnly ? <span className="text-fg-3">read-only for you</span> : null}
    </span>
  );
}

export function SettingsDirectory({ role }: { role: string | null }) {
  const [q, setQ] = useState("");
  const query = q.trim();
  const groups = useMemo(
    () =>
      SETTINGS_GROUPS.map((g) => ({
        ...g,
        hits: g.sections
          .map((s) => ({ s, why: match(s, query) }))
          .filter((x) => x.why !== false) as Array<{ s: SettingsSection; why: string | null }>,
      })).filter((g) => g.hits.length > 0),
    [query],
  );
  const total = groups.reduce((n, g) => n + g.hits.length, 0);

  return (
    <div className="flex flex-col gap-12">
      <div className="flex max-w-[640px] flex-col gap-2">
        <label htmlFor="settings-find" className="text-ui font-semibold text-fg">
          What do you need to do?
        </label>
        <SearchInput
          id="settings-find"
          size="lg"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Sign out a lost laptop, add our logo…"
          className="w-full"
          autoComplete="off"
          data-testid="settings-find"
        />
        <p className="text-meta text-fg-3" aria-live="polite">
          {query
            ? total === 0
              ? "No section matches that. Try a plainer word: delete, invite, logo, Slack, key."
              : `${total} section${total === 1 ? "" : "s"} match.`
            : "Or read down the four lines below. Each stop says who can change it."}
        </p>
      </div>

      <div className="grid gap-x-16 gap-y-14 lg:grid-cols-2">
        {groups.map((g) => (
          <section key={g.id} aria-labelledby={`grp-${g.id}`} className="flex min-w-0 flex-col">
            <h2 id={`grp-${g.id}`} className="display text-h2 text-fg">
              {g.title}
            </h2>
            <p className="mt-1 max-w-[56ch] text-ui text-fg-3">{g.lede}</p>
            <div className="mt-5">
              <ul className="flex flex-col">
                {g.hits.map(({ s, why }, i) => {
                  const can = role === null ? null : mayChange(role, s.who);
                  return (
                    <li key={s.key} className="relative">
                      {i < g.hits.length - 1 ? (
                        <span aria-hidden className="absolute -bottom-[24px] left-[9px] top-[23px] w-[5px] bg-fg" />
                      ) : null}
                      <Link
                        href={s.href}
                        data-testid={`settings-entry-${s.key}`}
                        className="group/entry relative grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 rounded-ctl py-3 pl-9 pr-1"
                      >
                        <span
                          aria-hidden
                          className="absolute left-[3px] top-[15px] z-[1] block size-[17px] rounded-full border-[3px] border-fg bg-paper transition-[width,left] duration-150 group-hover/entry:-left-[1.5px] group-hover/entry:w-[26px]"
                        />
                        <span className="min-w-0">
                          <span className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
                            <span className="text-body font-bold text-fg decoration-rule-2 underline-offset-[3px] group-hover/entry:underline">
                              {s.label}
                            </span>
                            {s.irreversible ? (
                              <span className="inline-flex items-center gap-1 text-meta font-semibold text-fg-2">
                                <PermanentMark size={8} />
                                holds a permanent action
                              </span>
                            ) : null}
                          </span>
                          <span className="mt-0.5 block text-ui text-fg-2">{s.does}</span>
                          {why ? (
                            <span className="mt-1 block text-meta font-semibold text-fg">
                              Matches &ldquo;{why}&rdquo;
                            </span>
                          ) : null}
                          <span className="mt-1.5 block sm:hidden">
                            <WhoCan who={s.who} can={can} />
                          </span>
                        </span>
                        <span className="hidden items-center gap-3 pt-1 sm:flex">
                          <WhoCan who={s.who} can={can} />
                          <ArrowRight
                            size={14}
                            className="shrink-0 text-fg-4 transition-transform duration-150 group-hover/entry:translate-x-0.5 group-hover/entry:text-fg"
                          />
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
