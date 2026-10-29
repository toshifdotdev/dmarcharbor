"use client";

/**
 * subdomains-table.tsx — names below this domain that send mail and are not
 * monitored.
 *
 * Read from the domain's own aggregate reports (header_from), so nothing here
 * is guessed. Each row can be added to the client as a domain, which counts
 * against the plan's domain limit like any other, or dismissed so it stops
 * being listed. Dismissed rows stay one click away under "Show dismissed".
 *
 * Test hooks: subdomains-table, subdomain-row-<name>, subdomain-add-<name>,
 * subdomain-dismiss-<name>, subdomain-restore-<name>, subdomains-show-dismissed.
 */

import Link from "next/link";
import { useEffect, useState } from "react";
import { createDomain, setSubdomainDismissed } from "@/lib/ops-client";
import { fmtVolume } from "@/lib/posture";
import { domainHref } from "@/lib/route-hrefs";
import type { DiscoveredSubdomain } from "@/lib/types";
import { ActionRefusal, type ActionError } from "@/components/harbor/plan-refusal";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/choice";
import { Notice } from "@/components/ui/notice";
import { ErrorState } from "@/components/ui/states";
import { Nil, Table, TBody, Td, Th, THead, Tr } from "@/components/ui/table";

function shortDate(value: string | null): string {
  if (!value) return "not recorded";
  return new Date(value).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

export function SubdomainsTable({
  organizationId,
  domainId,
  clientId,
  domainName,
  subdomains,
  windowDays,
  failed,
  canEdit,
}: {
  organizationId: string;
  domainId: string;
  clientId: string;
  domainName: string;
  subdomains: DiscoveredSubdomain[] | null;
  windowDays: number;
  failed: boolean;
  canEdit: boolean;
}) {
  const [rows, setRows] = useState(subdomains ?? []);
  const [showDismissed, setShowDismissed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ActionError | null>(null);
  const [added, setAdded] = useState<{ name: string; slug: string } | null>(null);

  useEffect(() => setRows(subdomains ?? []), [subdomains]);

  if (failed || !subdomains) {
    return (
      <div data-testid="subdomains-load-failed">
        <ErrorState
          what="the subdomains seen sending"
          detail="The reports could not be read just now. This is not the same as none being seen."
        />
      </div>
    );
  }

  const dismissedCount = rows.filter((row) => row.dismissed).length;
  const visible = rows.filter((row) => showDismissed || !row.dismissed);

  async function add(row: DiscoveredSubdomain): Promise<void> {
    setBusy(row.name);
    setError(null);
    setAdded(null);
    const result = await createDomain(organizationId, clientId, { name: row.name });
    setBusy(null);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setRows((current) => current.filter((entry) => entry.name !== row.name));
    setAdded({ name: result.data.name, slug: result.data.slug });
  }

  async function dismiss(row: DiscoveredSubdomain, dismissed: boolean): Promise<void> {
    setBusy(row.name);
    setError(null);
    const result = await setSubdomainDismissed(organizationId, domainId, { name: row.name, dismissed });
    setBusy(null);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setRows((current) =>
      current.map((entry) =>
        entry.name === row.name
          ? { ...entry, dismissed: dismissed ? { at: new Date().toISOString(), by: null } : null }
          : entry,
      ),
    );
  }

  return (
    <div className="flex flex-col gap-3 pt-4" data-testid="subdomains-table">
      <p className="max-w-[80ch] text-ui text-fg-2">
        Names below <span className="data text-fg">{domainName}</span> that receivers reported as the From domain in
        the last {windowDays} days, and that this workspace does not monitor. Mail from them is covered by this
        domain&rsquo;s subdomain policy (sp=) unless they publish their own DMARC record.
      </p>
      {dismissedCount > 0 ? (
        <Checkbox
          checked={showDismissed}
          onChange={(event) => setShowDismissed(event.target.checked)}
          label={`Show dismissed (${dismissedCount})`}
          data-testid="subdomains-show-dismissed"
        />
      ) : null}
      <ActionRefusal error={error} />
      {added ? (
        <Notice tone="ok" title={`${added.name} added to this client`} role="status">
          It counts toward the plan&rsquo;s domains from now on.{" "}
          <Link className="link" href={domainHref(added.slug)}>
            Open it
          </Link>{" "}
          to verify ownership.
        </Notice>
      ) : null}

      {visible.length === 0 ? (
        <p className="border-b border-rule py-8 text-body text-fg-3" data-testid="subdomains-empty">
          {rows.length === 0
            ? `No unmonitored subdomain of ${domainName} has sent mail in the last ${windowDays} days.`
            : "Every subdomain seen is dismissed."}
        </p>
      ) : (
        <Table caption={`Subdomains of ${domainName} seen sending`} minWidth={880}>
          <THead>
            <tr>
              <Th>Subdomain</Th>
              <Th numeric>Messages</Th>
              <Th numeric>DMARC pass</Th>
              <Th numeric>Sources</Th>
              <Th>First seen</Th>
              <Th>Last seen</Th>
              {canEdit ? <Th align="right">Action</Th> : null}
            </tr>
          </THead>
          <TBody>
            {visible.map((row) => (
              <Tr
                key={row.name}
                data-testid={`subdomain-row-${row.name}`}
                tone={!row.dismissed && row.dmarcPassPercent !== null && row.dmarcPassPercent < 50 ? "warn" : undefined}
              >
                <Td mono className={row.dismissed ? "text-fg-3" : "font-semibold"}>
                  {row.name}
                  {row.dismissed ? <span className="ml-2 font-sans text-meta text-fg-3">dismissed</span> : null}
                </Td>
                <Td numeric>{fmtVolume(row.messages)}</Td>
                <Td numeric muted={row.dmarcPassPercent === null}>
                  {row.dmarcPassPercent === null ? <Nil /> : `${row.dmarcPassPercent}%`}
                </Td>
                <Td numeric>{row.sourceCount}</Td>
                <Td muted>{shortDate(row.firstSeenAt)}</Td>
                <Td muted>{shortDate(row.lastSeenAt)}</Td>
                {canEdit ? (
                  <Td align="right">
                    <span className="inline-flex items-center gap-2">
                      {row.dismissed ? (
                        <Button
                          size="sm"
                          variant="secondary"
                          busy={busy === row.name}
                          busyLabel="Restoring"
                          onClick={() => dismiss(row, false)}
                          data-testid={`subdomain-restore-${row.name}`}
                        >
                          List again
                        </Button>
                      ) : (
                        <>
                          <Button
                            size="sm"
                            variant="secondary"
                            busy={busy === row.name}
                            busyLabel="Adding"
                            onClick={() => add(row)}
                            data-testid={`subdomain-add-${row.name}`}
                          >
                            Monitor
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy === row.name}
                            onClick={() => dismiss(row, true)}
                            data-testid={`subdomain-dismiss-${row.name}`}
                          >
                            Dismiss
                          </Button>
                        </>
                      )}
                    </span>
                  </Td>
                ) : null}
              </Tr>
            ))}
          </TBody>
        </Table>
      )}
      <p className="max-w-[80ch] text-meta text-fg-3">
        A pass rate under 50% is marked: either a real sender that is not set up yet, or someone using a name that
        looks like yours.
      </p>
    </div>
  );
}
