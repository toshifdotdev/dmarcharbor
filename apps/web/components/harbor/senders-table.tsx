"use client";

/**
 * senders-table.tsx — who sends for this domain, what the evidence calls them,
 * and the human decision about each one.
 *
 * The service name is never guessed from an ASN alone. The confidence label and
 * the evidence rows are part of the table because a name without them is a
 * claim the reader cannot check.
 */

import { Fragment, useEffect, useState } from "react";
import { reviewSender, setSenderOwner } from "@/lib/ops-client";
import { fmtVolume } from "@/lib/posture";
import { instantLabel } from "@/lib/instant";
import type { SenderRow, WorkspaceMemberRow } from "@/lib/types";
import { Badge, type Tone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/choice";
import { Select } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { Table, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import { UpgradeNotice } from "@/components/ui/states";

const SENDER_STATUS: Record<SenderRow["status"], { tone: Tone; label: string }> = {
  clean: { tone: "ok", label: "Clean" },
  degraded: { tone: "warn", label: "Degraded" },
  failing: { tone: "fail", label: "Failing" },
  "insufficient-data": { tone: "void", label: "Too little data" },
};

const CONFIDENCE: Record<SenderRow["confidence"], string> = {
  confirmed: "Confirmed by DKIM",
  likely: "Likely, from reverse DNS",
  network: "Network only",
  own: "Your own mail server",
  unknown: "Not identified",
};

function share(passed: number, total: number): string {
  return total > 0 ? `${Math.round((passed / total) * 100)}%` : "—";
}

function shortDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "not recorded"
    : date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function serviceLabel(row: SenderRow): string {
  if (row.service && (row.confidence === "confirmed" || row.confidence === "likely")) {
    return row.service.name;
  }
  if (row.confidence === "own") return "Your own mail server";
  if (row.confidence === "network") {
    return row.network
      ? `Network: AS${row.network.asn}${row.network.asnName ? ` ${row.network.asnName}` : ""}`
      : "Network only";
  }
  return "Not identified";
}

export function SendersTable({
  organizationId,
  domainId,
  domainName,
  senders,
  canReview,
  ownerFeature,
  ownersPlanLabel,
  members,
}: {
  organizationId: string;
  domainId: string;
  domainName: string;
  senders: SenderRow[];
  canReview: boolean;
  ownerFeature: boolean | null;
  ownersPlanLabel: string;
  members: WorkspaceMemberRow[];
}) {
  const [rows, setRows] = useState(senders);
  const [unreviewedFirst, setUnreviewedFirst] = useState(false);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setRows(senders), [senders]);

  const unreviewed = rows.filter((row) => row.review.status === "UNREVIEWED").length;
  const pendingLookups = rows.some((row) => row.intelPending);
  const ordered = [...rows].sort((left, right) => {
    if (unreviewedFirst) {
      const leftUnreviewed = left.review.status === "UNREVIEWED" ? 0 : 1;
      const rightUnreviewed = right.review.status === "UNREVIEWED" ? 0 : 1;
      if (leftUnreviewed !== rightUnreviewed) return leftUnreviewed - rightUnreviewed;
    }
    return (
      right.dmarcFailedMessages - left.dmarcFailedMessages ||
      right.totalMessages - left.totalMessages ||
      right.senderKey.localeCompare(left.senderKey)
    );
  });

  const owners = members
    .filter((member) => ["owner", "admin", "analyst", "viewer"].includes(member.role))
    .map((member) => ({
      id: member.userId,
      name: member.user?.name?.trim() || member.user?.email || member.userId,
    }));

  async function review(row: SenderRow, status: SenderRow["review"]["status"]): Promise<void> {
    setBusy(row.senderKey);
    setError(null);
    const result = await reviewSender(organizationId, domainId, {
      senderKey: row.senderKey,
      status,
    });
    setBusy(null);
    if (!result.ok) {
      setError(result.error.message ?? "That review could not be saved.");
      return;
    }
    setRows((current) =>
      current.map((entry) =>
        entry.senderKey === row.senderKey
          ? { ...entry, review: result.data.review, owner: result.data.owner }
          : entry,
      ),
    );
  }

  async function assign(row: SenderRow, ownerUserId: string | null): Promise<void> {
    setBusy(row.senderKey);
    setError(null);
    const result = await setSenderOwner(organizationId, domainId, {
      senderKey: row.senderKey,
      ownerUserId,
    });
    setBusy(null);
    if (!result.ok) {
      setError(result.error.message ?? "That owner could not be saved.");
      return;
    }
    setRows((current) =>
      current.map((entry) =>
        entry.senderKey === row.senderKey
          ? { ...entry, review: result.data.review, owner: result.data.owner }
          : entry,
      ),
    );
  }

  if (rows.length === 0) {
    return <p className="border-b border-rule py-8 text-body text-fg-3">No sender has been observed yet. Senders appear here as receivers report mail claiming this domain.</p>;
  }

  return (
    <div className="flex flex-col gap-3 pt-4" data-testid="senders-table">
      <p className="text-ui text-fg-2">
        <span className={unreviewed > 0 ? "tnum font-semibold text-warn" : "tnum font-semibold text-fg"}>{unreviewed}</span>{" "}
        unreviewed sender{unreviewed === 1 ? "" : "s"}. A service name is shown only when public DNS or the report&rsquo;s own
        authentication results support it; the evidence is under each row.
      </p>
      {pendingLookups ? (
        <p className="text-meta text-fg-3" data-testid="sender-intel-pending">
          Reverse DNS and network lookups are still running for some sources.
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-4">
        <Checkbox
          checked={unreviewedFirst}
          onChange={(event) => setUnreviewedFirst(event.target.checked)}
          label="Unreviewed first"
          data-testid="sender-unreviewed-first"
        />
        <span className="text-meta text-fg-3">Every percentage is of that sender&rsquo;s own messages.</span>
      </div>
      {error ? <Notice tone="fail" title={error} role="alert" /> : null}
      {ownerFeature === false ? (
        <UpgradeNotice
          message={`Sender owners are not included in this workspace's plan. They are included from ${ownersPlanLabel}.`}
          feature="senders.owners"
        />
      ) : null}

      <Table caption={`Senders observed for ${domainName}`} minWidth={1280}>
        <THead>
          <tr>
            <Th>Sender</Th>
            <Th numeric>Sources</Th>
            <Th numeric>Messages</Th>
            <Th numeric>Failed DMARC</Th>
            <Th numeric>DMARC share</Th>
            <Th numeric>DKIM pass</Th>
            <Th numeric>SPF pass</Th>
            <Th>Review</Th>
            <Th>Owner</Th>
            <Th>Status</Th>
            <Th numeric>Last seen</Th>
            <Th>
              <span className="sr-only">Evidence</span>
            </Th>
          </tr>
        </THead>
        <TBody>
          {ordered.map((row) => {
            const open = openKey === row.senderKey;
            return (
              <Fragment key={row.senderKey}>
                <Tr tone={row.status === "failing" ? "fail" : undefined}>
                  <Td>
                    <span className="data block font-semibold text-fg" data-testid={`sender-service-${row.senderKey}`}>
                      {serviceLabel(row)}
                    </span>
                    <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-meta">
                      {row.service ? <Badge tone="neutral">{row.service.category}</Badge> : null}
                      <span className="text-fg-3">{CONFIDENCE[row.confidence]}</span>
                      <span className="data break-all text-fg-2">{row.senderDomain ?? row.senderKey}</span>
                    </span>
                  </Td>
                  <Td numeric muted title={row.sourceIps.slice(0, 8).join(", ")}>
                    {row.sourceIps.length}
                  </Td>
                  <Td numeric>{fmtVolume(row.totalMessages)}</Td>
                  <Td
                    numeric
                    className={row.dmarcFailedMessages > 0 ? "font-semibold text-fail" : undefined}
                    title={`Not aligned on both: ${row.failedMessages} message${row.failedMessages === 1 ? "" : "s"}`}
                  >
                    {fmtVolume(row.dmarcFailedMessages)}
                    {row.failedMessages !== row.dmarcFailedMessages ? (
                      <span className="mt-0.5 block text-meta font-normal text-fg-3">
                        Not aligned on both: {fmtVolume(row.failedMessages)}
                      </span>
                    ) : null}
                  </Td>
                  <Td numeric className={row.dmarcFailedMessages > 0 ? "font-semibold text-fail" : "text-fg-3"}>
                    {row.dmarcFailureSharePercent}%
                  </Td>
                  <Td numeric muted>{share(row.dkimPassMessages, row.totalMessages)}</Td>
                  <Td numeric muted>{share(row.spfPassMessages, row.totalMessages)}</Td>
                  <Td>
                    {canReview ? (
                      <Select
                        value={row.review.status}
                        onChange={(event) => void review(row, event.target.value as SenderRow["review"]["status"])}
                        disabled={busy === row.senderKey}
                        aria-label={`Review ${serviceLabel(row)}`}
                        data-testid={`sender-review-${row.senderKey}`}
                      >
                        <option value="UNREVIEWED">Unreviewed</option>
                        <option value="APPROVED">Approved</option>
                        <option value="NOT_OURS">Not ours</option>
                      </Select>
                    ) : (
                      <span className="text-meta text-fg-2">
                        {row.review.status === "APPROVED" ? "Approved" : row.review.status === "NOT_OURS" ? "Not ours" : "Unreviewed"}
                      </span>
                    )}
                    {row.review.note ? <span className="mt-1 block max-w-[220px] text-meta text-fg-3">{row.review.note}</span> : null}
                  </Td>
                  <Td>
                    {ownerFeature === true && canReview ? (
                      <Select
                        value={row.owner?.id ?? ""}
                        onChange={(event) => void assign(row, event.target.value || null)}
                        disabled={busy === row.senderKey}
                        aria-label={`Owner for ${serviceLabel(row)}`}
                        data-testid={`sender-owner-${row.senderKey}`}
                      >
                        <option value="">Unassigned</option>
                        {owners.map((owner) => (
                          <option key={owner.id} value={owner.id}>
                            {owner.name}
                          </option>
                        ))}
                      </Select>
                    ) : row.owner ? (
                      <span className="text-meta text-fg-2">{row.owner.name}</span>
                    ) : (
                      <span className="text-meta text-fg-3">No owner</span>
                    )}
                  </Td>
                  <Td>
                    <Badge tone={SENDER_STATUS[row.status].tone}>{SENDER_STATUS[row.status].label}</Badge>
                  </Td>
                  <Td numeric muted title={`first seen ${instantLabel(row.firstSeenAt)}`}>
                    {shortDate(row.lastSeenAt)}
                  </Td>
                  <Td align="right">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setOpenKey(open ? null : row.senderKey)}
                      aria-expanded={open}
                      data-testid={`sender-evidence-${row.senderKey}`}
                    >
                      {open ? "Hide" : "Evidence"}
                    </Button>
                  </Td>
                </Tr>
                {open ? (
                  <tr className="border-b border-rule bg-paper">
                    <td colSpan={12} className="px-3 py-4">
                      <p className="legend">How this name was decided</p>
                      {row.evidence.length === 0 ? (
                        <p className="mt-1 text-ui text-fg-3">No evidence has matched a known service.</p>
                      ) : (
                        <ul className="mt-1 flex flex-col gap-1 text-meta text-fg-2">
                          {row.evidence.map((line) => (
                            <li key={line} className="data break-all">
                              {line}
                            </li>
                          ))}
                        </ul>
                      )}
                      {row.network ? (
                        <p className="mt-2 text-meta text-fg-3">
                          Network: AS{row.network.asn} {row.network.asnName ?? ""}
                        </p>
                      ) : null}
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </TBody>
      </Table>
    </div>
  );
}
