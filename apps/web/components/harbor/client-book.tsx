"use client";

/**
 * client-book.tsx — the client book: every client, its domains, and where each
 * domain stands in setup.
 *
 * One table, grouped by client, because an operator scans it like a ledger:
 * the client's name, then its domains beneath, each with its ownership state
 * and the DMARC policy last read from DNS. Two things narrow it at once: a
 * filter over client and domain names, and "Needs DNS work", which leaves only
 * the domains whose ownership record is not live yet: the morning's to-do list.
 *
 * Beside it, the two forms that build the book (client-forms.tsx). "Add
 * domains" on a client row points the domain form at that client and puts the
 * cursor in it.
 *
 * Deleting a client is rare and takes evidence with it, so it is a dialog that
 * names the domains going, asks for the client's name typed out when there are
 * any, and reports back what the API says it removed. A client whose contact
 * still holds portal access is refused by the API; the refusal says where to
 * revoke it.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import { deleteClient, type DeletionSummary } from "@/lib/ops-client";
import { domainHref, onboardingHref } from "@/lib/route-hrefs";
import type { DomainStatus } from "@/lib/types";
import { Badge, type Tone } from "@/components/ui/badge";
import { Button, ButtonLink } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy";
import { Dialog } from "@/components/ui/dialog";
import { Input, SearchInput, Segmented } from "@/components/ui/field";
import { External, Plus } from "@/components/ui/icons";
import { Notice } from "@/components/ui/notice";
import { Nil } from "@/components/ui/table";
import { AddClient, AddDomains } from "./client-forms";

export interface DomainView {
  id: string;
  slug: string;
  name: string;
  status: DomainStatus;
  policy: string | null;
  addedLabel: string | null;
  scannedLabel: string | null;
}

export interface ClientView {
  id: string;
  name: string;
  slug: string;
  trustSlug: string | null;
  /** The address this client publishes in rua. */
  reportAddress: string;
  domains: DomainView[];
}

const OWNERSHIP: Record<DomainStatus, { label: string; tone: Tone; hint: string }> = {
  VERIFIED: { label: "Verified", tone: "ok", hint: "The ownership record is live." },
  PENDING: { label: "Awaiting ownership record", tone: "warn", hint: "Publish the ownership TXT record, then check DNS on the setup page." },
  FAILED: { label: "Ownership record gone", tone: "fail", hint: "It was verified, and the record has since been removed from DNS." },
};

const SUMMARY_WORDS: Array<[keyof DeletionSummary, string, string]> = [
  ["domains", "domain", "domains"],
  ["dmarcReports", "report", "reports"],
  ["forensicReports", "forensic report", "forensic reports"],
  ["alertRules", "alert rule", "alert rules"],
  ["alertEvents", "alert event", "alert events"],
  ["reportDigests", "digest", "digests"],
  ["scans", "scan", "scans"],
  ["reportShares", "share link", "share links"],
  ["compliancePacks", "compliance pack", "compliance packs"],
];

function summarise(s: DeletionSummary): string {
  const parts = SUMMARY_WORDS.filter(([k]) => s[k] > 0).map(([k, one, many]) => `${s[k]} ${s[k] === 1 ? one : many}`);
  return parts.length ? parts.join(", ") : "nothing else was attached";
}

export function ClientBook({
  organizationId,
  clients,
  limits,
}: {
  organizationId: string;
  clients: ClientView[];
  limits: { plan: string; maxClients: number; maxActiveDomains: number } | null;
}) {
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<"all" | "dns">("all");
  // A client created a moment ago is a valid target before the refresh lands.
  const [justCreated, setJustCreated] = useState<{ id: string; name: string } | null>(null);
  const [target, setTarget] = useState<string>(clients[0]?.id ?? "");
  const [removing, setRemoving] = useState<ClientView | null>(null);
  const [removed, setRemoved] = useState<string | null>(null);
  const domainInput = useRef<HTMLInputElement | null>(null);
  const formsRef = useRef<HTMLDivElement | null>(null);

  const choices = useMemo(() => {
    const list = clients.map((c) => ({ id: c.id, name: c.name }));
    if (justCreated && !list.some((c) => c.id === justCreated.id)) list.unshift(justCreated);
    return list;
  }, [clients, justCreated]);
  const effectiveTarget = choices.some((c) => c.id === target) ? target : (choices[0]?.id ?? "");

  const domainTotal = clients.reduce((n, c) => n + c.domains.length, 0);
  const needsDns = clients.reduce((n, c) => n + c.domains.filter((d) => d.status !== "VERIFIED").length, 0);
  const atLimit = limits !== null && clients.length >= limits.maxClients;

  const q = query.trim().toLowerCase();
  const visible = clients
    .map((c) => {
      const clientHit = !q || c.name.toLowerCase().includes(q) || c.slug.includes(q);
      let domains = c.domains;
      if (scope === "dns") domains = domains.filter((d) => d.status !== "VERIFIED");
      if (q && !clientHit) domains = domains.filter((d) => d.name.includes(q));
      const show = (clientHit || domains.length > 0) && (scope === "all" || domains.length > 0);
      return show ? { ...c, domains } : null;
    })
    .filter((c): c is ClientView => c !== null);

  function addDomainsTo(id: string) {
    setTarget(id);
    formsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    // After the scroll starts, so the focus does not jump the page twice.
    setTimeout(() => domainInput.current?.focus({ preventScroll: true }), 250);
  }

  return (
    <div className="grid gap-x-10 gap-y-10 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="flex min-w-0 flex-col gap-4">
        {limits ? (
          <p className="flex flex-wrap gap-x-5 gap-y-1 text-meta text-fg-3" data-testid="client-usage">
            <span>
              Clients <span className="tnum font-semibold text-fg-2">{clients.length}</span> of{" "}
              <span className="tnum">{limits.maxClients}</span>
            </span>
            <span>
              Domains <span className="tnum font-semibold text-fg-2">{domainTotal}</span>; the {limits.plan} plan allows{" "}
              <span className="tnum">{limits.maxActiveDomains}</span> active
            </span>
          </p>
        ) : null}

        {removed ? (
          <Notice tone="ok" title="Client deleted" action={<Button size="sm" variant="ghost" onClick={() => setRemoved(null)}>Dismiss</Button>}>
            {removed}
          </Notice>
        ) : null}

        {clients.length === 0 ? (
          <section role="status" data-testid="state-empty" className="border-y border-rule py-8">
            <h2 className="text-h3 font-semibold text-fg">No clients yet</h2>
            <p className="mt-1.5 max-w-[60ch] text-body text-fg-2">
              A client is a company whose mail domains you look after. Add the first one with the form beside this, then
              its domains: each one gets two records to publish, and the Portfolio fills in as reports arrive.
            </p>
          </section>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <SearchInput
                aria-label="Filter clients and domains"
                placeholder="Filter clients and domains"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="w-full sm:w-[280px]"
              />
              <Segmented
                label="Which domains"
                size="sm"
                value={scope}
                onChange={setScope}
                options={[
                  { value: "all", label: `All ${domainTotal}` },
                  { value: "dns", label: `Needs DNS work ${needsDns}` },
                ]}
              />
              {q || scope === "dns" ? (
                <span className="text-meta text-fg-3" aria-live="polite">
                  {visible.length} of {clients.length} client{clients.length === 1 ? "" : "s"}
                </span>
              ) : null}
            </div>

            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] border-collapse border-y border-fg text-left text-ui">
                <caption className="sr-only">Clients and their domains</caption>
                <thead className="border-b border-rule-2">
                  <tr>
                    <th scope="col" className="legend px-2.5 py-2 font-semibold">
                      Domain
                    </th>
                    <th scope="col" className="legend px-2.5 py-2 font-semibold">
                      Ownership
                    </th>
                    <th scope="col" className="legend px-2.5 py-2 font-semibold">
                      Policy in DNS
                    </th>
                    <th scope="col" className="legend px-2.5 py-2 font-semibold">
                      Added
                    </th>
                    <th scope="col" className="px-2.5 py-2">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                {visible.length === 0 ? (
                  <tbody>
                    <tr>
                      <td colSpan={5} className="px-3 py-10 text-center text-ui text-fg-3">
                        {scope === "dns" && !q ? "Every domain has its ownership verified." : "Nothing matches that filter."}
                      </td>
                    </tr>
                  </tbody>
                ) : (
                  visible.map((c, ci) => (
                    <tbody key={c.id} data-client-id={c.id} className="hb-stagger" style={{ "--i": Math.min(ci, 8) } as React.CSSProperties}>
                      <tr className="border-b border-rule bg-paper-2/60">
                        <th scope="rowgroup" colSpan={4} className="px-2.5 py-2.5 text-left">
                          <span className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                            <span className="text-body font-bold text-fg">{c.name}</span>
                            <span className="data text-meta font-normal text-fg-3">{c.slug}</span>
                            <span className="text-meta font-normal text-fg-3">
                              <span className="tnum">{clients.find((x) => x.id === c.id)?.domains.length ?? 0}</span> domain
                              {(clients.find((x) => x.id === c.id)?.domains.length ?? 0) === 1 ? "" : "s"}
                            </span>
                            {c.trustSlug ? (
                              <a
                                href={`/trust/${c.trustSlug}`}
                                target="_blank"
                                rel="noreferrer"
                                className="link inline-flex items-center gap-1 text-meta font-semibold"
                              >
                                Trust Center <External size={11} />
                              </a>
                            ) : null}
                          </span>
                          <span data-copy-scope className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-meta font-normal text-fg-3">
                            <span className="legend">rua</span>
                            <code data-copy-value className="data break-all text-fg">
                              {c.reportAddress}
                            </code>
                            <CopyButton
                              value={c.reportAddress}
                              label={`Copy the report address for ${c.name}`}
                              testId={`copy-report-address-${c.id}`}
                            />
                            <span>Put this address in rua for this client&rsquo;s domains.</span>
                          </span>
                        </th>
                        <td className="whitespace-nowrap px-2.5 py-2 text-right">
                          <ButtonLink
                            href={`/clients/switch?client=${encodeURIComponent(c.id)}`}
                            size="sm"
                            variant="ghost"
                            data-testid={`switch-domains-${c.id}`}
                          >
                            Switch domains from another provider
                          </ButtonLink>
                          <Button size="sm" variant="ghost" onClick={() => addDomainsTo(c.id)} aria-label={`Add domains to ${c.name}`}>
                            <Plus size={13} /> Add domains
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setRemoving(clients.find((x) => x.id === c.id) ?? c)}
                            data-testid="delete-client"
                            aria-label={`Delete ${c.name}`}
                          >
                            Delete
                          </Button>
                        </td>
                      </tr>
                      {c.domains.length === 0 ? (
                        <tr className="border-b border-rule">
                          <td colSpan={5} className="px-2.5 py-2.5 pl-6 text-meta text-fg-3">
                            No domains yet.{" "}
                            <button type="button" className="link font-semibold" onClick={() => addDomainsTo(c.id)}>
                              Add the first
                            </button>
                          </td>
                        </tr>
                      ) : (
                        c.domains.map((d) => {
                          const own = OWNERSHIP[d.status];
                          return (
                            <tr
                              key={d.id}
                              data-domain-id={d.id}
                              className="border-b border-rule align-baseline"
                              style={d.status === "VERIFIED" ? undefined : { boxShadow: `inset 2px 0 0 var(--color-${d.status === "FAILED" ? "fail" : "warn-mark"})` }}
                            >
                              <td className="py-2 pl-6 pr-2.5">
                                <Link
                                  href={d.status === "VERIFIED" ? domainHref(d.slug) : onboardingHref(d.slug)}
                                  className="data font-semibold text-fg hover:text-act hover:underline"
                                >
                                  {d.name}
                                </Link>
                              </td>
                              <td className="px-2.5 py-2">
                                <Badge tone={own.tone} title={own.hint}>
                                  {own.label}
                                </Badge>
                              </td>
                              <td className="px-2.5 py-2">
                                {d.policy ? (
                                  <span className="data text-meta text-fg" title={d.scannedLabel ? `Read from DNS on ${d.scannedLabel}` : undefined}>
                                    p={d.policy}
                                  </span>
                                ) : (
                                  <Nil label="not scanned yet" />
                                )}
                              </td>
                              <td className="tnum whitespace-nowrap px-2.5 py-2 text-meta text-fg-3">{d.addedLabel ?? <Nil label="not recorded" />}</td>
                              <td className="whitespace-nowrap px-2.5 py-2 text-right text-meta">
                                <Link href={onboardingHref(d.slug)} className="link font-semibold">
                                  Setup
                                </Link>
                                <span aria-hidden className="px-1.5 text-fg-4">
                                  ·
                                </span>
                                <Link href={domainHref(d.slug)} className="link font-semibold">
                                  Evidence
                                </Link>
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  ))
                )}
              </table>
            </div>
          </>
        )}
      </div>

      <div ref={formsRef} className="flex scroll-mt-28 flex-col gap-8 self-start lg:sticky lg:top-[104px]">
        <AddClient
          organizationId={organizationId}
          atLimit={atLimit}
          limitLine={
            limits
              ? `The ${limits.plan} plan allows ${limits.maxClients} client${limits.maxClients === 1 ? "" : "s"}, and this workspace has ${clients.length}.`
              : null
          }
          onCreated={(c) => {
            setJustCreated({ id: c.id, name: c.name });
            setTarget(c.id);
          }}
        />
        <div className="border-t border-rule pt-6">
          <AddDomains ref={domainInput} organizationId={organizationId} clients={choices} target={effectiveTarget} onTarget={setTarget} />
        </div>
      </div>

      <DeleteClientDialog
        organizationId={organizationId}
        client={removing}
        onClose={() => setRemoving(null)}
        onDeleted={(line) => {
          setRemoving(null);
          setRemoved(line);
        }}
      />
    </div>
  );
}

function DeleteClientDialog({
  organizationId,
  client,
  onClose,
  onDeleted,
}: {
  organizationId: string;
  client: ClientView | null;
  onClose: () => void;
  onDeleted: (line: string) => void;
}) {
  const router = useRouter();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; portal: boolean } | null>(null);
  const [shownFor, setShownFor] = useState<string | null>(null);

  // A fresh dialog per client: reset the typed name and any refusal.
  if (client && client.id !== shownFor) {
    setShownFor(client.id);
    setTyped("");
    setError(null);
  }

  const n = client?.domains.length ?? 0;
  const needsName = n > 0;
  const confirmed = !needsName || typed.trim().toLowerCase() === client?.name.toLowerCase();

  async function run() {
    if (!client || !confirmed || busy) return;
    setBusy(true);
    setError(null);
    const res = await deleteClient(organizationId, client.id);
    setBusy(false);
    if (!res.ok) {
      setError({ message: res.error.message ?? "The client could not be deleted.", portal: res.error.code === "PORTAL_ACCESS_STILL_GRANTED" });
      return;
    }
    onDeleted(`${res.data.deleted} was deleted, with ${summarise(res.data.summary)}.`);
    router.refresh();
  }

  return (
    <Dialog
      open={client !== null}
      onClose={busy ? () => {} : onClose}
      title={client ? `Delete ${client.name}?` : ""}
      testId="delete-client-confirm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" onClick={run} disabled={!confirmed} busy={busy} busyLabel="Deleting" data-testid="delete-client-confirm-button">
            {n > 0 ? "Delete the client and its evidence" : "Delete the client"}
          </Button>
        </>
      }
    >
      {client ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run();
          }}
          className="flex flex-col gap-3"
        >
          {n === 0 ? (
            <p className="text-body text-fg-2">The client has no domains, so nothing else is attached. This cannot be undone.</p>
          ) : (
            <>
              <p className="text-body text-fg-2">
                This deletes the client and its {n} domain{n === 1 ? "" : "s"}, with every report, forensic report, scan,
                alert, digest and share link attached to them. Live share links stop working. This cannot be undone.
              </p>
              <ul className="data flex max-h-[140px] flex-col gap-0.5 overflow-y-auto border-y border-rule py-2 text-meta text-fg">
                {client.domains.map((d) => (
                  <li key={d.id}>{d.name}</li>
                ))}
              </ul>
              <label htmlFor="delete-client-name" className="text-meta font-semibold text-fg-2">
                Type <span className="text-fg">{client.name}</span> to confirm
              </label>
              <Input id="delete-client-name" size="lg" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
            </>
          )}
          {error ? (
            <div role="alert" data-testid="delete-client-error" className="text-ui text-fail">
              <p className="font-semibold">{error.message}</p>
              {error.portal ? (
                <ButtonLink href="/settings/portal" size="sm" className="mt-2">
                  Open portal access
                </ButtonLink>
              ) : null}
            </div>
          ) : null}
        </form>
      ) : null}
    </Dialog>
  );
}
