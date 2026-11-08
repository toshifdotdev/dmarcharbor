"use client";

/**
 * dns-zone-import.tsx — adding the domains a connected Cloudflare account
 * already holds, without typing them.
 *
 * Opened from one connection on the DNS publishing page. It reads the zones in
 * that account (read only), marks each by where it stands, and adds the chosen
 * ones to one client through the ordinary bulk import, so the plan limit and
 * the held-elsewhere check apply exactly as they do to a pasted list.
 *
 * The line at the top is the account drawn as a progress line: green for the
 * zones already monitored here, a dashed accent for the ones ready to add (the
 * next action), grey for the ones another workspace monitors.
 *
 * Test hooks: zone-import, zone-import-line, zone-list, zone-row (data-state),
 * zone-select-all, zone-client, zone-import-submit; the result is bulk-result.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { clsx } from "clsx";
import { bulkCreateDomains, listDnsConnectionZones, type BulkDomainResult, type ImportableZone } from "@/lib/ops-client";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/choice";
import { Field, SearchInput, Select } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { InlineWaiting } from "@/components/ui/states";
import { ActionRefusal, type ActionError } from "../plan-refusal";
import { BULK_DOMAIN_MAX, BulkResult } from "../client-forms";

export interface ImportClient {
  id: string;
  name: string;
}

type Loaded =
  | { phase: "loading" }
  | { phase: "failed"; message: string }
  | { phase: "ready"; zones: ImportableZone[]; truncated: boolean };

/** Past this many zones the list gets a filter box. */
const FILTER_FROM = 12;

export function ZoneImport({
  organizationId,
  connectionId,
  clients,
  onClose,
}: {
  organizationId: string;
  connectionId: string;
  /** Null when the client list could not be read. */
  clients: ImportClient[] | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const [loaded, setLoaded] = useState<Loaded>({ phase: "loading" });
  const [chosen, setChosen] = useState<Set<string>>(() => new Set());
  const [clientId, setClientId] = useState<string>(clients?.length === 1 ? clients[0].id : "");
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ActionError | null>(null);
  const [outcome, setOutcome] = useState<{ clientName: string; result: BulkDomainResult } | null>(null);

  const load = useCallback(async () => {
    const res = await listDnsConnectionZones(organizationId, connectionId);
    if (!res.ok) {
      setLoaded({ phase: "failed", message: res.error.message ?? "Cloudflare did not return the zone list. Nothing was changed." });
      return;
    }
    setLoaded({ phase: "ready", zones: res.data.zones, truncated: res.data.truncated });
  }, [organizationId, connectionId]);

  useEffect(() => {
    // The zone list is read from Cloudflare when the panel opens, not on page load.
    void load();
  }, [load]);

  const zones = useMemo(() => (loaded.phase === "ready" ? loaded.zones : []), [loaded]);
  const available = useMemo(() => zones.filter((z) => z.state === "available"), [zones]);
  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return needle ? zones.filter((z) => z.name.includes(needle)) : zones;
  }, [zones, filter]);
  const shownAvailable = shown.filter((z) => z.state === "available");
  const allShownChosen = shownAvailable.length > 0 && shownAvailable.every((z) => chosen.has(z.name));
  const client = clients?.find((c) => c.id === clientId) ?? null;
  const count = chosen.size;

  function toggle(name: string, on: boolean) {
    setChosen((current) => {
      const next = new Set(current);
      if (on) next.add(name);
      else next.delete(name);
      return next;
    });
  }

  function toggleShown(on: boolean) {
    setChosen((current) => {
      const next = new Set(current);
      for (const z of shownAvailable) {
        if (on) next.add(z.name);
        else next.delete(z.name);
      }
      return next;
    });
  }

  async function submit() {
    if (busy || count === 0) return;
    if (!client) {
      setError({ message: "Choose which client these domains belong to." });
      return;
    }
    setBusy(true);
    setError(null);
    const res = await bulkCreateDomains(organizationId, client.id, [...chosen].sort());
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setOutcome({ clientName: client.name, result: res.data });
    setChosen(new Set());
    router.refresh();
    // Read the zones again so the ones just added show as monitored here.
    void load();
  }

  return (
    <section
      aria-label="Import domains from this Cloudflare account"
      data-testid="zone-import"
      className="mt-2 flex flex-col gap-4 border-t border-rule pt-4"
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h4 className="text-ui font-semibold text-fg">Import domains from this account</h4>
        <span className="text-meta text-fg-3">Reads the zone list; nothing at Cloudflare changes.</span>
        <span className="flex-1" />
        <Button size="sm" variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>

      {loaded.phase === "loading" ? (
        <InlineWaiting testId="zone-loading">Reading the zones in this Cloudflare account</InlineWaiting>
      ) : loaded.phase === "failed" ? (
        <Notice
          tone="fail"
          title="The zone list could not be read"
          action={
            <Button size="sm" variant="secondary" onClick={() => { setLoaded({ phase: "loading" }); void load(); }}>
              Retry
            </Button>
          }
        >
          {loaded.message} The token needs <span className="font-semibold text-fg">Zone → Zone → Read</span> on the zones
          you want listed.
        </Notice>
      ) : zones.length === 0 ? (
        <p className="text-ui text-fg-2" data-testid="zone-none">
          This token can see no zones. Give it <span className="font-semibold text-fg">Zone → Zone → Read</span> on the
          client zones in Cloudflare, then open this again.
        </p>
      ) : (
        <>
          <ZoneLine zones={zones} />

          {loaded.truncated ? (
            <Notice tone="warn" title={`Only the first ${zones.length.toLocaleString("en-GB")} zones are listed`}>
              The account holds more. Add the rest from a client&rsquo;s page with a pasted list.
            </Notice>
          ) : null}

          {zones.length >= FILTER_FROM ? (
            <SearchInput
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter zones"
              aria-label="Filter zones"
              className="max-w-[320px]"
            />
          ) : null}

          <div className="flex flex-col">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-rule pb-2">
              {shownAvailable.length > 0 ? (
                <Checkbox
                  label={
                    allShownChosen
                      ? "Clear the ready zones"
                      : shownAvailable.length === 1
                        ? "Choose the 1 ready to add"
                        : `Choose all ${shownAvailable.length} ready to add`
                  }
                  checked={allShownChosen}
                  onChange={(e) => toggleShown(e.target.checked)}
                  data-testid="zone-select-all"
                />
              ) : (
                // Nothing to choose: say so rather than offer "Choose all 0" (session 20).
                <span className="text-meta text-fg-3" data-testid="zone-none-ready">
                  None ready to add: every zone here is already monitored.
                </span>
              )}
              <span className="flex-1" />
              <span className="text-meta text-fg-3 tnum">{shown.length === zones.length ? zoneCount(zones.length) : `${shown.length} of ${zoneCount(zones.length)}`}</span>
            </div>
            <ul className="flex max-h-[320px] flex-col overflow-y-auto" data-testid="zone-list">
              {shown.map((zone) => (
                <li
                  key={zone.name}
                  data-testid="zone-row"
                  data-state={zone.state}
                  className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 border-b border-rule py-2 pr-3 last:border-b-0"
                >
                  {zone.state === "available" ? (
                    <Checkbox
                      label={<span className="data">{zone.name}</span>}
                      checked={chosen.has(zone.name)}
                      onChange={(e) => toggle(zone.name, e.target.checked)}
                      className="min-w-0"
                    />
                  ) : (
                    <Checkbox label={<span className="data">{zone.name}</span>} checked={zone.state === "here"} disabled className="min-w-0" />
                  )}
                  <span className="flex-1" />
                  <ZoneWord zone={zone} />
                </li>
              ))}
              {shown.length === 0 ? <li className="py-3 text-ui text-fg-3">No zone matches “{filter.trim()}”.</li> : null}
            </ul>
          </div>

          {available.length > 0 ? (
            clients === null ? (
              <Notice tone="fail" title="The client list could not be read">
                Reload the page to choose a client. Nothing was added.
              </Notice>
            ) : clients.length === 0 ? (
              <Notice tone="warn" title="Add a client first">
                Domains are added under a client.{" "}
                <Link href="/clients" className="link">
                  Create one on the clients page
                </Link>
                , then come back here.
              </Notice>
            ) : (
              <div className="flex flex-wrap items-end gap-3">
                <Field label="Add them to" className="min-w-[220px]">
                  <Select value={clientId} onChange={(e) => setClientId(e.target.value)} data-testid="zone-client" className="w-full">
                    <option value="">Choose a client</option>
                    {clients.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Button
                  variant="primary"
                  onClick={submit}
                  busy={busy}
                  busyLabel={`Adding ${count} domains`}
                  disabled={count === 0 || count > BULK_DOMAIN_MAX}
                  data-testid="zone-import-submit"
                >
                  {count === 0 ? "Add domains" : `Add ${count} domain${count === 1 ? "" : "s"}${client ? ` to ${client.name}` : ""}`}
                </Button>
              </div>
            )
          ) : null}
          {count > BULK_DOMAIN_MAX ? (
            <p className="text-meta font-semibold text-warn">
              One import takes up to {BULK_DOMAIN_MAX} domains. Choose fewer and add the rest in a second import.
            </p>
          ) : null}

          <ActionRefusal error={error} />
        </>
      )}

      {outcome ? (
        <div className="flex flex-col gap-2">
          <BulkResult clientName={outcome.clientName} result={outcome.result} />
          {outcome.result.domains.length > 0 ? (
            <p className="text-meta text-fg-3">
              These zones are on this Cloudflare account, so each setup page can publish its records with “Publish with
              Cloudflare” instead of copying them.
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function zoneCount(n: number): string {
  return `${n.toLocaleString("en-GB")} ${n === 1 ? "zone" : "zones"}`;
}

/** Where a zone stands, as a word with its mark. */
function ZoneWord({ zone }: { zone: ImportableZone }) {
  if (zone.state === "here") {
    return (
      <span className="inline-flex items-center gap-1.5 text-meta">
        <span aria-hidden className="inline-block size-2 bg-done" />
        <span className="font-semibold text-ok">Monitored</span>
        <span className="text-fg-3">under {zone.clientName ?? "a client"}</span>
      </span>
    );
  }
  if (zone.state === "elsewhere") {
    return (
      <span className="inline-flex items-center gap-1.5 text-meta text-fg-3">
        <span aria-hidden className="inline-block size-2 rounded-full border border-fg-4" />
        Monitored by another workspace
      </span>
    );
  }
  return <span className="text-meta font-semibold text-act">Ready to add</span>;
}

/**
 * The account as one line: monitored here (green, travelled), ready to add
 * (dashed accent, the next action), held by another workspace (grey). Each
 * segment's length follows its count, with a floor so a single zone still shows.
 */
function ZoneLine({ zones }: { zones: ImportableZone[] }) {
  const here = zones.filter((z) => z.state === "here").length;
  const ready = zones.filter((z) => z.state === "available").length;
  const elsewhere = zones.length - here - ready;
  const parts = [
    { key: "here", n: here, name: "monitored here", line: "bg-done" },
    {
      key: "ready",
      n: ready,
      name: "ready to add",
      line: "bg-[repeating-linear-gradient(90deg,var(--color-act)_0_10px,transparent_10px_16px)]",
    },
    { key: "elsewhere", n: elsewhere, name: "in another workspace", line: "bg-rule-2" },
  ].filter((p) => p.n > 0);
  const summary = parts.map((p) => `${p.n} ${p.name}`).join(", ");

  return (
    <figure className="flex flex-col gap-2" data-testid="zone-import-line">
      <div role="img" aria-label={`${zoneCount(zones.length)} in this account: ${summary}.`} className="flex items-center gap-1.5">
        <span aria-hidden className="size-3.5 shrink-0 rounded-full border-[3px] border-fg bg-paper" />
        <div className="flex min-w-0 flex-1 gap-1">
          {parts.map((p) => (
            <span key={p.key} className={clsx("h-[5px] rounded-full", p.line)} style={{ flexGrow: p.n, flexBasis: 0, minWidth: 12 }} />
          ))}
        </div>
        <span aria-hidden className="h-3.5 w-6 shrink-0 rounded-full border-[3px] border-fg bg-paper" />
      </div>
      <figcaption className="flex flex-wrap gap-x-5 gap-y-1 text-meta text-fg-3">
        <span>
          <span className="font-semibold text-fg tnum">{zones.length}</span> {zones.length === 1 ? "zone" : "zones"} in this account
        </span>
        {parts.map((p) => (
          <span key={p.key} className="inline-flex items-center gap-1.5">
            <span aria-hidden className={clsx("h-[5px] w-4 rounded-full", p.line)} />
            <span>
              <span className="font-semibold text-fg tnum">{p.n}</span> {p.name}
            </span>
          </span>
        ))}
      </figcaption>
    </figure>
  );
}
