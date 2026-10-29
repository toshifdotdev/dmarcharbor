"use client";

/**
 * spf-usage.tsx — which parts of the SPF record carried any mail.
 *
 * Asked for on demand: a published record is resolved live, which is a dozen
 * DNS lookups or more, and nobody needs that on every page view. Each source
 * is matched against the sending addresses in the domain's reports. "Not
 * used" is said only with enough reports behind it, and a source whose
 * networks cannot be known in advance says so rather than guessing.
 *
 * Test hooks: spf-usage, spf-usage-check, spf-usage-row-<term>,
 * spf-usage-status-<term>, spf-usage-problem.
 */

import { useState } from "react";
import { getSpfUsage } from "@/lib/ops-client";
import { fmtVolume } from "@/lib/posture";
import type { SpfSourceUsage, SpfUsage as SpfUsageView } from "@/lib/types";
import { Badge, type Tone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { Nil, Table, TBody, Td, Th, THead, Tr } from "@/components/ui/table";

const STATUS: Record<SpfSourceUsage["status"], { tone: Tone; label: string }> = {
  used: { tone: "ok", label: "Carried mail" },
  unused: { tone: "warn", label: "No mail seen" },
  insufficient_data: { tone: "neutral", label: "Too few reports" },
  unresolved: { tone: "neutral", label: "Cannot be checked" },
};

export function SpfUsage({ organizationId, domainId }: { organizationId: string; domainId: string }) {
  const [view, setView] = useState<SpfUsageView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function check(): Promise<void> {
    setBusy(true);
    setError(null);
    const result = await getSpfUsage(organizationId, domainId);
    setBusy(false);
    if (!result.ok) {
      setError(result.error.message ?? "The SPF record could not be checked just now.");
      return;
    }
    setView(result.data);
  }

  const unused = view?.sources.filter((source) => source.status === "unused") ?? [];
  const freed = unused.reduce((sum, source) => sum + (source.lookups ?? 0), 0);

  return (
    <section aria-labelledby="spf-usage-head" className="flex flex-col gap-4 border-b border-rule-2 pb-6" data-testid="spf-usage">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="spf-usage-head" className="text-h3 font-bold tracking-[-0.01em] text-fg">
            SPF sources in use
          </h2>
          <p className="mt-1 max-w-[72ch] text-ui text-fg-2">
            Matches each include and address range in the SPF record against the servers that sent this
            domain&rsquo;s mail in the last 90 days. A source nothing came from is a candidate to remove: it costs
            lookups toward the limit of 10 and still lets that service send as the domain.
          </p>
        </div>
        <Button size="sm" variant="secondary" onClick={check} busy={busy} busyLabel="Checking the record" data-testid="spf-usage-check">
          {view ? "Check again" : "Check SPF sources"}
        </Button>
      </div>

      {error ? <Notice tone="fail" title={error} /> : null}

      {view?.problem ? (
        <Notice tone="warn" title="Nothing to check" testId="spf-usage-problem">
          {view.problem}
        </Notice>
      ) : null}

      {view && !view.problem ? (
        <div className="flex flex-col gap-3">
          <p className="max-w-[80ch] text-ui text-fg-2">
            {view.origin === "managed" ? "Managed SPF sources, as last resolved. " : "The record published now"}
            {view.origin === "published" && view.lookupCount !== null ? `, which costs ${view.lookupCount} of 10 lookups. ` : view.origin === "published" ? ". " : ""}
            Reports on <span className="tnum font-semibold text-fg">{view.evidence.reportDays}</span> of the last{" "}
            {view.windowDays} days, from <span className="tnum font-semibold text-fg">{fmtVolume(view.evidence.ips)}</span>{" "}
            sending addresses.
          </p>
          {!view.evidence.enough ? (
            <Notice tone="info" title="Too few reports to call anything unused">
              That needs reports on at least 14 days. Sources that carried mail are still marked.
            </Notice>
          ) : unused.length > 0 ? (
            <Notice tone="warn" title={`${unused.length} source${unused.length === 1 ? "" : "s"} carried no mail`}>
              {view.origin === "published" && freed > 0
                ? `Removing ${unused.length === 1 ? "it" : "them"} frees ${freed} lookup${freed === 1 ? "" : "s"}. `
                : ""}
              Confirm with the client that the service is no longer used before removing it: a service that sends
              rarely, such as a yearly invoice run, may not appear in 90 days.
            </Notice>
          ) : null}

          <Table caption="SPF sources and the mail they carried" minWidth={760}>
            <THead>
              <tr>
                <Th>Source</Th>
                <Th>Status</Th>
                <Th numeric>Messages</Th>
                <Th numeric>SPF pass</Th>
                <Th numeric>Addresses</Th>
                <Th numeric>Lookups</Th>
              </tr>
            </THead>
            <TBody>
              {view.sources.map((source) => (
                <Tr key={source.term} data-testid={`spf-usage-row-${source.term}`} tone={source.status === "unused" ? "warn" : undefined}>
                  <Td mono className="break-all">
                    {source.term}
                    {source.reason ? <span className="mt-0.5 block font-sans text-meta text-fg-3">{source.reason}</span> : null}
                  </Td>
                  <Td>
                    <span data-testid={`spf-usage-status-${source.term}`}>
                      <Badge tone={STATUS[source.status].tone}>{STATUS[source.status].label}</Badge>
                    </span>
                  </Td>
                  <Td numeric muted={source.status === "unresolved"}>
                    {source.status === "unresolved" ? <Nil label="not measured" /> : fmtVolume(source.messages)}
                  </Td>
                  <Td numeric muted={source.status === "unresolved"}>
                    {source.status === "unresolved" ? <Nil label="not measured" /> : fmtVolume(source.spfPassMessages)}
                  </Td>
                  <Td numeric muted={source.status === "unresolved"}>
                    {source.status === "unresolved" ? <Nil label="not measured" /> : source.matchedIps}
                  </Td>
                  <Td numeric muted={source.lookups === null}>
                    {source.lookups === null ? <Nil /> : source.lookups}
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
          {view.uncovered.messages > 0 ? (
            <p className="max-w-[80ch] text-meta text-fg-3">
              {fmtVolume(view.uncovered.messages)} messages came from {view.uncovered.ips} address
              {view.uncovered.ips === 1 ? "" : "es"} no source covers: a sender missing from SPF, forwarded mail, or
              someone sending as the domain. The Senders tab shows who they are.
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
