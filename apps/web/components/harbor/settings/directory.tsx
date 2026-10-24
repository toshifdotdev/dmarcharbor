"use client";

/**
 * directory.tsx — the settings index: every section, found by what you need
 * to do.
 *
 * The search reads the same task phrases Jump does ("sign out a lost laptop",
 * "delete a client's personal data"), so a person who does not know a section
 * is called Erasure still lands on it. Each entry says who can change it, and
 * whether that includes you, before you open it.
 */

import Link from "next/link";
import { useMemo, useState } from "react";
import { mayChange, SETTINGS_GROUPS, type SettingsSection, type Who } from "@/lib/settings-map";
import { SearchInput } from "@/components/ui/field";
import { ArrowRight } from "@/components/ui/icons";

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
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="settings-find" className="text-meta font-semibold text-fg-2">
          What do you need to do?
        </label>
        <SearchInput
          id="settings-find"
          size="lg"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Sign out a lost laptop, add our logo…"
          className="w-full max-w-[640px]"
          autoComplete="off"
          data-testid="settings-find"
        />
        <p className="text-meta text-fg-3" aria-live="polite">
          {query
            ? total === 0
              ? "No section matches that. Try a plainer word: delete, invite, logo, Slack, key."
              : `${total} section${total === 1 ? "" : "s"} match.`
            : "Or browse the four groups below."}
        </p>
      </div>

      <div className="grid gap-x-12 gap-y-10 lg:grid-cols-2">
        {groups.map((g) => (
          <section key={g.id} aria-labelledby={`grp-${g.id}`} className="flex flex-col [animation:hb-rise_200ms_ease-out]">
            <h2 id={`grp-${g.id}`} className="text-h2 font-bold tracking-[-0.02em] text-fg">
              {g.title}
            </h2>
            <p className="mt-0.5 text-ui text-fg-2">{g.lede}</p>
            <ul className="mt-3 border-t border-fg">
              {g.hits.map(({ s, why }) => {
                const can = role === null ? null : mayChange(role, s.who);
                return (
                  <li key={s.key} className="border-b border-rule">
                    <Link
                      href={s.href}
                      data-testid={`settings-entry-${s.key}`}
                      className="group flex items-start gap-3 py-3 transition-colors duration-75 hover:bg-paper-3/50"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-baseline gap-x-2">
                          <span className="text-body font-semibold text-fg group-hover:underline">{s.label}</span>
                          {s.irreversible ? (
                            <span className="inline-flex items-center gap-1 text-meta font-semibold text-fail">
                              <span aria-hidden className="size-[6px] rotate-45 bg-fail" />
                              holds a permanent action
                            </span>
                          ) : null}
                        </span>
                        <span className="mt-0.5 block text-ui text-fg-2">{s.does}</span>
                        {why ? (
                          <span className="mt-1 block text-meta text-act">
                            Matches &ldquo;{why}&rdquo;
                          </span>
                        ) : null}
                      </span>
                      <span className="hidden shrink-0 flex-col items-end gap-0.5 pt-0.5 text-right sm:flex">
                        <span className="text-meta font-semibold text-fg-3">{WHO_LABEL[s.who]}</span>
                        {s.who !== "anyone" && can === false ? (
                          <span className="text-meta font-semibold text-fg-2">read-only for you</span>
                        ) : null}
                      </span>
                      <ArrowRight size={14} className="mt-1.5 shrink-0 text-fg-4 transition-transform group-hover:translate-x-0.5 group-hover:text-fg" />
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
