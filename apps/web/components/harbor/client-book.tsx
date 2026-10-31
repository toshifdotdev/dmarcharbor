"use client";

/**
 * client-book.tsx — the client book: every client, its domains, and where each
 * domain stands in setup.
 *
 * One table, grouped by client, because an operator scans it like a ledger.
 * Each client is drawn as a line, the way the map draws a sender: an origin at
 * the client's name, and a station for each of its domains beneath, filled in
 * ink once the ownership record is live and hollow until it is. The client's
 * rua address sits under its name with a copy control, because handing that
 * address to whoever runs a client's DNS is the most common job on this page.
 *
 * Two things narrow it at once: a filter over client and domain names, and
 * "Needs DNS work", which leaves only the domains whose ownership record is
 * not live yet: the morning's to-do list.
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
 *
 * Test hooks kept: client-usage, data-client-id, data-domain-id,
 * copy-report-address-<id>, switch-domains-<id> (in the same row as the
 * client's name), monthly-reports-<id>, delete-client, delete-client-confirm,
 * delete-client-confirm-button, delete-client-error, state-empty.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { clsx } from "clsx";
import {
  deleteClient,
  previewWorkspaceDeletion,
  type DeletionSummary,
  type HostedDeletionPreview,
  type ManagedSpfDeletionPreview,
} from "@/lib/ops-client";
import { domainHref, onboardingHref } from "@/lib/route-hrefs";
import type { DomainStatus } from "@/lib/types";
import { Button, ButtonLink } from "@/components/ui/button";
import { CopyButton, DnsRecord } from "@/components/ui/copy";
import { Dialog } from "@/components/ui/dialog";
import { Input, SearchInput, Segmented } from "@/components/ui/field";
import { External, Plus } from "@/components/ui/icons";
import { Notice } from "@/components/ui/notice";
import { Nil } from "@/components/ui/table";
import { AddClient, AddDomains } from "./client-forms";
import { PolicyStrip } from "./policy-strip";

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

const OWNERSHIP: Record<DomainStatus, { label: string; hint: string }> = {
  VERIFIED: { label: "Verified", hint: "The ownership record is live." },
  PENDING: { label: "Awaiting ownership record", hint: "Publish the ownership TXT record, then check DNS on the setup page." },
  FAILED: { label: "Ownership record gone", hint: "It was verified, and the record has since been removed from DNS." },
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

/* The client line's geometry, in px from the cell's left edge. */
const LINE = "left-[14.5px] w-[3px]";

export function ClientBook({
  organizationId,
  clients,
  limits,
  productName = "this service",
}: {
  organizationId: string;
  clients: ClientView[];
  limits: { plan: string; maxClients: number; maxActiveDomains: number } | null;
  /** The product's name as this host shows it (white label), for the deletion warnings. */
  productName?: string;
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
    <div className="grid gap-x-12 gap-y-10 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="flex min-w-0 flex-col gap-4">
        {limits ? (
          <p className="tnum text-meta text-fg-3" data-testid="client-usage">
            <span className="font-semibold text-fg-2">{clients.length}</span> of {limits.maxClients} clients and{" "}
            <span className="font-semibold text-fg-2">{domainTotal}</span> domains; the {limits.plan} plan allows{" "}
            {limits.maxActiveDomains} active domains.
          </p>
        ) : null}

        {removed ? (
          <Notice tone="ok" title="Client deleted" action={<Button size="sm" variant="ghost" onClick={() => setRemoved(null)}>Dismiss</Button>}>
            {removed}
          </Notice>
        ) : null}

        {clients.length === 0 ? (
          <section role="status" data-testid="state-empty" className="flex flex-col gap-3 border-t border-rule pt-6">
            <h2 className="text-h3 font-bold text-fg">No clients yet</h2>
            <p className="max-w-[60ch] text-body text-fg-2">
              A client is a company whose mail domains you look after. Add the first one with the form beside this, then
              its domains: each one gets two records to publish, and the Portfolio fills in as reports arrive.
            </p>
          </section>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
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
                <span className="tnum text-meta text-fg-3" aria-live="polite">
                  {visible.length} of {clients.length} client{clients.length === 1 ? "" : "s"}
                </span>
              ) : null}
            </div>

            <div className="relative overflow-x-auto">
              <table className="w-full min-w-[720px] border-collapse text-left text-ui">
                <caption className="sr-only">Clients and their domains</caption>
                <thead className="border-b border-rule-2">
                  <tr>
                    <th scope="col" className="legend py-2 pl-9 pr-2.5 align-bottom font-semibold">
                      Client and domains
                    </th>
                    <th scope="col" className="legend w-[190px] px-2.5 py-2 align-bottom font-semibold">
                      Ownership
                    </th>
                    <th scope="col" className="legend w-[250px] px-2.5 py-2 align-bottom font-semibold">
                      Policy in DNS
                    </th>
                    <th scope="col" className="legend w-[104px] px-2.5 py-2 align-bottom font-semibold">
                      Added
                    </th>
                    <th scope="col" className="w-[130px] px-2.5 py-2">
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
                  visible.map((c) => {
                    const all = clients.find((x) => x.id === c.id) ?? c;
                    return (
                      <ClientGroup
                        key={c.id}
                        client={c}
                        total={all.domains.length}
                        onAddDomains={() => addDomainsTo(c.id)}
                        onDelete={() => setRemoving(all)}
                      />
                    );
                  })
                )}
              </table>
            </div>
            <p className="max-w-[90ch] text-meta text-fg-3">
              Each client&rsquo;s report address goes in the rua tag of the DMARC record on every domain under it.
              Domains whose ownership record is not live yet open on their setup page.
            </p>
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
        <div className="border-t border-rule pt-7">
          <AddDomains ref={domainInput} organizationId={organizationId} clients={choices} target={effectiveTarget} onTarget={setTarget} />
        </div>
      </div>

      <DeleteClientDialog
        organizationId={organizationId}
        client={removing}
        productName={productName}
        onClose={() => setRemoving(null)}
        onDeleted={(line) => {
          setRemoving(null);
          setRemoved(line);
        }}
      />
    </div>
  );
}

/**
 * One client: its heading row (origin, name, rua address, actions) and a row
 * per domain, joined by the client's line. The switch link must stay in the
 * heading row, the first row that names the client.
 */
function ClientGroup({
  client: c,
  total,
  onAddDomains,
  onDelete,
}: {
  client: ClientView;
  /** Every domain the client has, whatever the filter leaves. */
  total: number;
  onAddDomains: () => void;
  onDelete: () => void;
}) {
  const hasRows = c.domains.length > 0;
  return (
    <tbody data-client-id={c.id}>
      <tr>
        <th scope="rowgroup" colSpan={5} className="relative px-2.5 pb-1.5 pl-9 pt-6 text-left align-top font-normal">
          {/* The client's line runs down from its origin to the last domain. */}
          <span aria-hidden className={clsx("absolute bottom-[-1px] top-[33px]", LINE, hasRows ? "bg-fg" : "border-l-[3px] border-dashed border-fg-4")} />
          <span aria-hidden className="absolute left-[9px] top-[27px] size-[14px] rounded-full border-[3px] border-fg bg-paper" />
          <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
            <div className="min-w-0">
              <p className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
                <span className="text-body font-bold text-fg">{c.name}</span>
                <span className="tnum text-meta text-fg-3">
                  {total} domain{total === 1 ? "" : "s"}
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
              </p>
              <p data-copy-scope className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-meta">
                <span className="text-fg-3">Report address</span>
                <code data-copy-value className="data break-all text-fg">
                  {c.reportAddress}
                </code>
                <CopyButton value={c.reportAddress} label={`Copy the report address for ${c.name}`} testId={`copy-report-address-${c.id}`} />
              </p>
            </div>
            <div className="-mr-1 flex flex-wrap items-center gap-0.5">
              <Button size="sm" variant="ghost" onClick={onAddDomains} aria-label={`Add domains to ${c.name}`}>
                <Plus size={13} /> Add domains
              </Button>
              <ButtonLink
                href={`/clients/reports?client=${encodeURIComponent(c.id)}`}
                size="sm"
                variant="ghost"
                data-testid={`monthly-reports-${c.id}`}
                aria-label={`Monthly reports for ${c.name}`}
              >
                Monthly reports
              </ButtonLink>
              <ButtonLink
                href={`/clients/switch?client=${encodeURIComponent(c.id)}`}
                size="sm"
                variant="ghost"
                data-testid={`switch-domains-${c.id}`}
                aria-label={`Switch provider for ${c.name}: move its domains from another DMARC provider`}
                title="Move this client's domains from another DMARC provider"
              >
                Switch provider
              </ButtonLink>
              <Button
                size="sm"
                variant="ghost"
                onClick={onDelete}
                data-testid="delete-client"
                aria-label={`Delete ${c.name}`}
              >
                Delete
              </Button>
            </div>
          </div>
        </th>
      </tr>
      {hasRows ? (
        c.domains.map((d, i) => <DomainRow key={d.id} domain={d} last={i === c.domains.length - 1} />)
      ) : (
        <tr className="border-b border-rule">
          <td colSpan={5} className="relative py-2.5 pl-9 pr-2.5 text-meta text-fg-3">
            <span aria-hidden className={clsx("absolute top-[-1px] h-[16px] border-l-[3px] border-dashed border-fg-4", LINE)} />
            <span aria-hidden className="absolute left-[11px] top-[13px] size-[10px] rounded-full border-[2.5px] border-rule-2 bg-paper" />
            No domains yet.{" "}
            <button type="button" className="link font-semibold" onClick={onAddDomains}>
              Add the first
            </button>
          </td>
        </tr>
      )}
    </tbody>
  );
}

function DomainRow({ domain: d, last }: { domain: DomainView; last: boolean }) {
  const own = OWNERSHIP[d.status];
  const live = d.status === "VERIFIED";
  return (
    <tr data-domain-id={d.id} className="border-b border-rule align-baseline">
      <td className="relative py-2 pl-9 pr-2.5">
        <span aria-hidden className={clsx("absolute top-[-1px] bg-fg", LINE, last ? "h-[19px]" : "bottom-[-1px]")} />
        <span
          aria-hidden
          className={clsx(
            "absolute left-[11px] top-[12px] size-[10px] rounded-full border-[2.5px] bg-paper",
            live ? "border-fg" : "border-rule-2",
          )}
        />
        <Link
          href={live ? domainHref(d.slug) : onboardingHref(d.slug)}
          className="data font-semibold text-fg hover:text-act hover:underline"
        >
          {d.name}
        </Link>
      </td>
      <td className="px-2.5 py-2">
        <OwnershipWord status={d.status} label={own.label} hint={own.hint} />
      </td>
      <td className="px-2.5 py-2">
        <PolicyStrip
          inline
          policy={d.policy}
          emptyLabel="not scanned yet"
          title={d.scannedLabel ? `Read from DNS on ${d.scannedLabel}` : "DNS has not been scanned for this domain yet"}
        />
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
}

/** Ownership as a state word with its shape: square live, ring awaited, diamond gone. */
function OwnershipWord({ status, label, hint }: { status: DomainStatus; label: string; hint: string }) {
  return (
    <span
      title={hint}
      className={clsx(
        "inline-flex items-center gap-1.5 whitespace-nowrap text-meta font-semibold",
        status === "VERIFIED" ? "text-ok" : status === "FAILED" ? "text-fail" : "text-warn",
      )}
    >
      <span
        aria-hidden
        className={clsx(
          "block shrink-0",
          status === "VERIFIED" && "size-2 bg-ok",
          status === "FAILED" && "size-[7px] rotate-45 bg-fail",
          status === "PENDING" && "size-[9px] rounded-full border-2 border-warn-mark",
        )}
      />
      {label}
    </span>
  );
}

function DeleteClientDialog({
  organizationId,
  client,
  productName,
  onClose,
  onDeleted,
}: {
  organizationId: string;
  client: ClientView | null;
  productName: string;
  onClose: () => void;
  onDeleted: (line: string) => void;
}) {
  const router = useRouter();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; portal: boolean } | null>(null);
  const [shownFor, setShownFor] = useState<string | null>(null);
  const [hosted, setHosted] = useState<HostedDeletionPreview[]>([]);
  const [managedSpf, setManagedSpf] = useState<ManagedSpfDeletionPreview[]>([]);

  useEffect(() => {
    if (!client) {
      setHosted([]);
      setManagedSpf([]);
      return;
    }
    let active = true;
    previewWorkspaceDeletion(organizationId, client.id)
      .then((result) => {
        if (active && result.ok) {
          setHosted(result.data.hostedDmarc ?? []);
          setManagedSpf(result.data.managedSpf ?? []);
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [client, organizationId]);

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
              {hosted.length > 0 ? (
                <div className="rounded-[10px] border border-warn/30 bg-warn-wash p-3">
                  <p className="font-semibold text-fg">These domains read their DMARC record from {productName}.</p>
                  <p className="mt-1 text-meta text-fg-2">
                    Publish this TXT at your DNS host and remove the CNAME first, or the domain will have no DMARC record
                    once it is deleted here.
                  </p>
                  <div className="mt-3 flex flex-col gap-3">
                    {hosted.map((record) => (
                      <div key={record.domain}>
                        <p className="data mb-1 text-meta font-semibold text-fg">{record.domain}</p>
                        <DnsRecord
                          type="TXT"
                          host={record.republish.host}
                          zone={record.republish.host.replace(/^_dmarc\./, "")}
                          value={record.republish.value}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
              {managedSpf.length > 0 ? (
                <div className="rounded-[10px] border border-warn/30 bg-warn-wash p-3">
                  <p className="font-semibold text-fg">These domains&rsquo; SPF records are managed by {productName}.</p>
                  <p className="mt-1 text-meta text-fg-2">
                    Publish this TXT at your DNS host and remove the redirect to {productName} first, or the domain will
                    lose its SPF record once it is deleted here.
                  </p>
                  <div className="mt-3 flex flex-col gap-3">
                    {managedSpf.map((record) => (
                      <div key={record.domain}>
                        <p className="data mb-1 text-meta font-semibold text-fg">{record.domain}</p>
                        <DnsRecord
                          type="TXT"
                          host={record.republish.host}
                          zone={record.republish.host}
                          value={record.republish.value}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
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
