"use client";

/**
 * jump.tsx — go to any domain, client, workspace or screen by typing.
 *
 * An MSP operator's real navigation is by name: a client calls about
 * "billing@northwind", and the fastest path to the evidence is typing
 * "northw" anywhere in the product. Sections are a secondary way in. So the
 * location bar carries a Jump field, Ctrl K (⌘K) or "/" opens it from
 * anywhere, and it searches:
 *
 *   domains     every domain in the active workspace, with its client
 *   clients     every client, with how many domains it holds
 *   workspaces  switching, for the agency with many
 *   screens     every section and settings page, by what it is called
 *
 * The workspace's client list is read once, when Jump first opens (one call,
 * through the same-origin proxy), never on page load: the bar costs nothing
 * until it is used. A failed read says so and still offers screens.
 *
 * WAI-ARIA combobox with a listbox popup: arrow keys move, Enter opens, Escape
 * closes, and the active option is announced through aria-activedescendant.
 */

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { clsx } from "clsx";
import { opsCall } from "@/lib/ops-client";
import { domainHref, onboardingHref } from "@/lib/route-hrefs";
import type { ClientRow, WorkspaceSummary } from "@/lib/types";
import { Search } from "@/components/ui/icons";
import { Kbd } from "@/components/ui/notice";
import { switchWorkspace } from "./workspace-menu";

type Kind = "domain" | "client" | "workspace" | "screen";
interface Entry {
  id: string;
  kind: Kind;
  label: string;
  detail?: string;
  /** Extra words that should match but are not shown. */
  keywords?: string;
  go: () => void;
  alt?: { label: string; go: () => void };
}

const SCREENS: Array<[string, string, string?]> = [
  ["/", "Portfolio", "home domains posture"],
  ["/clients", "Clients", "add client domain"],
  ["/alerts", "Alerts", "rules events"],
  ["/digests", "Digests", "scheduled report email"],
  ["/notifications", "Notifications", "inbox"],
  ["/settings", "Settings"],
  ["/settings/workspace", "Settings: Workspace", "name delete"],
  ["/settings/members", "Settings: Members", "invite roles team"],
  ["/settings/portal", "Settings: Client portal", "access contacts"],
  ["/settings/branding", "Settings: Branding", "white label logo colour custom domain"],
  ["/settings/audit", "Settings: Audit trail", "log history"],
  ["/settings/api-keys", "Settings: API keys", "token"],
  ["/settings/sso", "Settings: SSO", "saml oidc single sign on"],
  ["/settings/sessions", "Settings: Sessions", "signed in devices"],
  ["/settings/webhooks", "Settings: Webhooks", "endpoint deliveries"],
  ["/settings/slack", "Settings: Slack", "channel"],
  ["/settings/mailbox", "Settings: Report mailbox", "imap inbox rua"],
  ["/settings/compliance", "Settings: Compliance packs", "evidence pdf fingerprint"],
  ["/settings/export", "Settings: Export", "download data"],
  ["/settings/erasure", "Settings: Erasure", "delete gdpr"],
  ["/settings/forensics", "Settings: Forensic reports", "ruf failure samples"],
  ["/billing", "Billing", "plan invoice subscription"],
];

const KIND_LABEL: Record<Kind, string> = { domain: "Domains", client: "Clients", workspace: "Workspaces", screen: "Screens" };
const KIND_ORDER: Kind[] = ["domain", "client", "workspace", "screen"];

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function score(e: Entry, q: string): number {
  // No query: screens in the order an operator reaches for them (SCREENS is
  // ordered that way), not alphabetically.
  if (!q) return e.kind === "screen" ? 1000 - SCREENS.findIndex(([href]) => `s-${href}` === e.id) : 0;
  const label = e.label.toLowerCase();
  if (label === q) return 100;
  if (label.startsWith(q)) return 80;
  const words = label.split(/[\s.\-:]+/);
  if (words.some((w) => w.startsWith(q))) return 60;
  if (label.includes(q)) return 40;
  if ((e.detail ?? "").toLowerCase().includes(q)) return 20;
  if ((e.keywords ?? "").toLowerCase().includes(q)) return 15;
  return 0;
}

export function Jump({
  organizationId,
  workspaces,
  activeId,
}: {
  organizationId: string;
  workspaces: WorkspaceSummary[];
  activeId: string;
}) {
  const router = useRouter();
  const dialog = useRef<HTMLDialogElement | null>(null);
  const input = useRef<HTMLInputElement | null>(null);
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [cursor, setCursor] = useState(0);
  const [clients, setClients] = useState<ClientRow[] | null>(null);
  const [loadState, setLoadState] = useState<"idle" | "loading" | "failed" | "ready">("idle");

  const show = useCallback(() => setOpen(true), []);
  const hide = useCallback(() => {
    setOpen(false);
    setQ("");
    setCursor(0);
    // A failed read is retried on the next open, not in a loop while open.
    setLoadState((s) => (s === "failed" ? "idle" : s));
  }, []);

  // A different workspace means a different client list.
  useEffect(() => {
    setClients(null);
    setLoadState("idle");
  }, [organizationId]);

  // Global shortcut: Ctrl K / ⌘K anywhere, "/" when not typing in a field.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const typing = (e.target as HTMLElement)?.closest?.("input,textarea,select,[contenteditable=true]");
      if ((e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === "/" && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        setOpen(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    if (open && !el.open) {
      el.showModal();
      requestAnimationFrame(() => input.current?.focus());
    }
    if (!open && el.open) el.close();
  }, [open]);

  // First open in this workspace: read its clients and domains, once.
  useEffect(() => {
    if (!open || loadState !== "idle") return;
    setLoadState("loading");
    void opsCall<ClientRow[]>(`/api/workspaces/${organizationId}/clients`).then((r) => {
      if (r.ok) {
        setClients(r.data);
        setLoadState("ready");
      } else {
        setLoadState("failed");
      }
    });
  }, [open, loadState, organizationId]);

  const entries = useMemo<Entry[]>(() => {
    const nav = (href: string) => () => {
      hide();
      router.push(href);
    };
    const out: Entry[] = [];
    for (const c of clients ?? []) {
      out.push({
        id: `c-${c.id}`,
        kind: "client",
        label: c.name,
        detail: `${c.domains.length} domain${c.domains.length === 1 ? "" : "s"}`,
        keywords: c.slug,
        go: nav("/clients"),
      });
      for (const d of c.domains) {
        out.push({
          id: `d-${d.id}`,
          kind: "domain",
          label: d.name,
          detail: c.name,
          go: nav(domainHref(d.slug)),
          alt: { label: "Setup", go: nav(onboardingHref(d.slug)) },
        });
      }
    }
    for (const w of workspaces) {
      if (w.id === activeId) continue;
      out.push({
        id: `w-${w.id}`,
        kind: "workspace",
        label: w.name,
        detail: "switch workspace",
        keywords: w.slug,
        go: () => {
          hide();
          switchWorkspace(w.id);
          router.push("/");
          router.refresh();
        },
      });
    }
    for (const [href, label, keywords] of SCREENS) {
      out.push({ id: `s-${href}`, kind: "screen", label, keywords, go: nav(href) });
    }
    return out;
  }, [clients, workspaces, activeId, router, hide]);

  const results = useMemo(() => {
    const query = q.trim().toLowerCase();
    const scored = entries
      .map((e) => ({ e, s: score(e, query) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => KIND_ORDER.indexOf(a.e.kind) - KIND_ORDER.indexOf(b.e.kind) || b.s - a.s || a.e.label.localeCompare(b.e.label));
    // Cap each group so one large client cannot push screens off the list.
    const cap: Record<Kind, number> = { domain: query ? 12 : 0, client: query ? 6 : 0, workspace: query ? 6 : 0, screen: query ? 6 : 9 };
    const count: Record<Kind, number> = { domain: 0, client: 0, workspace: 0, screen: 0 };
    return scored.filter(({ e }) => count[e.kind]++ < cap[e.kind]).map((x) => x.e);
  }, [entries, q]);

  useEffect(() => setCursor(0), [q]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => Math.min(results.length - 1, c + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(0, c - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = results[cursor];
      if (hit) (e.shiftKey && hit.alt ? hit.alt.go : hit.go)();
    }
  }

  useEffect(() => {
    document.getElementById(`${listId}-${cursor}`)?.scrollIntoView({ block: "nearest" });
  }, [cursor, listId]);

  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

  return (
    <>
      <button
        type="button"
        onClick={show}
        aria-haspopup="dialog"
        aria-keyshortcuts="Control+K Meta+K /"
        className="flex h-8 min-w-0 items-center gap-2 rounded-ctl border border-rule-2 bg-paper-2 px-2.5 text-left text-ui text-fg-3 hover:border-fg-4 hover:text-fg-2 sm:w-[260px]"
      >
        <Search size={14} className="shrink-0" />
        <span className="hidden flex-1 truncate sm:block">Jump to a domain or client</span>
        <span className="sr-only sm:hidden">Jump to a domain or client</span>
        <span className="hidden items-center gap-0.5 sm:flex" aria-hidden>
          <Kbd>{isMac ? "⌘" : "Ctrl"}</Kbd>
          <Kbd>K</Kbd>
        </span>
      </button>

      <dialog
        ref={dialog}
        aria-label="Jump"
        onClose={hide}
        onCancel={(e) => {
          e.preventDefault();
          hide();
        }}
        onClick={(e) => {
          if (e.target === e.currentTarget) hide();
        }}
        className="hb-dialog mt-[12vh]! max-w-[min(640px,calc(100vw-24px))]"
      >
        {open ? (
          <div className="flex max-h-[70vh] flex-col">
            <div className="flex items-center gap-2.5 border-b border-rule px-4">
              <Search size={16} className="shrink-0 text-fg-3" />
              <input
                ref={input}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={onKeyDown}
                role="combobox"
                aria-expanded="true"
                aria-controls={listId}
                aria-activedescendant={results[cursor] ? `${listId}-${cursor}` : undefined}
                aria-autocomplete="list"
                aria-label="Search domains, clients, workspaces and screens"
                placeholder="Domain, client, workspace or screen"
                spellCheck={false}
                autoComplete="off"
                className="h-12 min-w-0 flex-1 bg-transparent text-body text-fg outline-none placeholder:text-fg-4"
              />
              {loadState === "loading" ? <span className="text-meta text-fg-3">Reading clients…</span> : null}
            </div>

            <ul id={listId} role="listbox" aria-label="Results" className="min-h-0 flex-1 overflow-y-auto p-1.5">
              {results.map((r, i) => {
                const first = i === 0 || results[i - 1].kind !== r.kind;
                const on = i === cursor;
                return (
                  <li key={r.id} role="presentation">
                    {first ? (
                      <p role="presentation" className="legend px-2.5 pb-1 pt-2.5">
                        {KIND_LABEL[r.kind]}
                      </p>
                    ) : null}
                    <div
                      id={`${listId}-${i}`}
                      role="option"
                      aria-selected={on}
                      onMouseMove={() => setCursor(i)}
                      onClick={r.go}
                      className={clsx(
                        "flex cursor-pointer items-center gap-3 rounded-[2px] px-2.5 py-1.5",
                        on ? "bg-paper-3 shadow-[inset_2px_0_0_var(--color-act)]" : "",
                      )}
                    >
                      <span className={clsx("min-w-0 flex-1 truncate text-ui font-semibold text-fg", r.kind === "domain" && "data")}>
                        {r.label}
                      </span>
                      {r.detail ? <span className="max-w-[40%] shrink-0 truncate text-meta text-fg-3">{r.detail}</span> : null}
                      {on && r.alt ? (
                        <span className="hidden shrink-0 items-center gap-1 text-meta text-fg-3 sm:flex">
                          <Kbd>⇧</Kbd>
                          <Kbd>↵</Kbd> {r.alt.label}
                        </span>
                      ) : null}
                    </div>
                  </li>
                );
              })}
              {results.length === 0 ? (
                <li role="presentation" className="px-3 py-8 text-center text-ui text-fg-3">
                  {loadState === "loading"
                    ? "Reading this workspace's clients…"
                    : <>Nothing in this workspace matches &ldquo;{q.trim()}&rdquo;.</>}
                </li>
              ) : null}
            </ul>

            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-rule bg-paper px-4 py-2 text-meta text-fg-3">
              {loadState === "failed" ? (
                <span role="status" className="font-semibold text-fail">
                  Clients could not be read, so domains are not listed. Screens still are.
                </span>
              ) : (
                <>
                  <span className="flex items-center gap-1">
                    <Kbd>↑</Kbd>
                    <Kbd>↓</Kbd> move
                  </span>
                  <span className="flex items-center gap-1">
                    <Kbd>↵</Kbd> open
                  </span>
                  <span className="flex items-center gap-1">
                    <Kbd>Esc</Kbd> close
                  </span>
                  {clients ? (
                    <span className="tnum ml-auto">
                      {plural(clients.reduce((n, c) => n + c.domains.length, 0), "domain")}, {plural(clients.length, "client")}
                    </span>
                  ) : null}
                </>
              )}
            </div>
          </div>
        ) : null}
      </dialog>
    </>
  );
}
