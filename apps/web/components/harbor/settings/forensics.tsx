"use client";

/**
 * forensics.tsx — per-message failure samples (DMARC ruf reports) for one
 * domain at a time.
 *
 * Three decisions, in order of how much they cost to get wrong:
 *   collecting   switching collection on or off. Off deletes nothing.
 *   naming       keeping recipient addresses, subjects and senders. Personal
 *                data: on needs a lawful basis confirmed; off destroys what is
 *                stored, permanently, and says so first.
 *   purging      deleting every sample for the domain, pseudonyms included.
 *                No grace period, no undo: typed domain name to confirm.
 *
 * The samples list renders what the list endpoint returns for this caller.
 * Opening one reads it again on demand, because whether names come back
 * depends on the caller's role (forensic:identify), not on the list.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  deleteForensicReport,
  fetchForensicReport,
  ingestForensicReport,
  purgeDomainForensics,
  setForensicCollection,
  setForensicIdentityRetention,
} from "@/lib/forensics-client";
import { instantLabel } from "@/lib/instant";
import { forensicsHref, onboardingHref } from "@/lib/route-hrefs";
import type { ForensicReportRow } from "@/lib/types";
import { ActionRefusal, type ActionError } from "@/components/harbor/plan-refusal";
import { Badge } from "@/components/ui/badge";
import { Button, ButtonLink } from "@/components/ui/button";
import { Checkbox, Switch, Textarea } from "@/components/ui/choice";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/field";
import { KeyValue, Notice } from "@/components/ui/notice";
import { Table, TBody, Td, TEmptyRow, Th, THead, Tr } from "@/components/ui/table";
import { UpgradeNotice } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { DangerZone, Panel } from "./parts";

export interface SampleView {
  id: string;
  receivedLabel: string;
  sourceIp: string;
  spf: string | null;
  dkim: string | null;
  disposition: string | null;
  recipients: number;
  identity: "withheld" | "stored" | "pseudonymous";
}

export interface DomainChoice {
  id: string;
  name: string;
  slug: string;
  clientName: string;
}

const pass = (r: string | null) => (r ? (r.toLowerCase() === "pass" ? "ok" : "fail") : "void");

export function ForensicsBoard({
  organizationId,
  domains,
  domain,
  samples,
  retention,
  paging,
  state,
  canIdentify,
  canPurge,
  canCollect,
  namedEntitled,
}: {
  organizationId: string;
  domains: DomainChoice[];
  domain: DomainChoice;
  samples: SampleView[] | null;
  retention: { days: number; piiDays: number } | null;
  paging: { nextCursor: string | null; hasMore: boolean; onLaterPage: boolean };
  /** From the domain's onboarding state; null when unreadable. */
  state: { collecting: boolean; naming: boolean; rufPublished: boolean; forensicAddress: string | null } | null;
  canIdentify: boolean;
  canPurge: boolean;
  canCollect: boolean;
  namedEntitled: boolean | null;
}) {
  const router = useRouter();
  const toast = useToast();
  const [collecting, setCollecting] = useState(state?.collecting ?? false);
  const [naming, setNaming] = useState(state?.naming ?? false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ActionError | null>(null);

  const [enableOpen, setEnableOpen] = useState(false);
  const [legalBasis, setLegalBasis] = useState(false);
  const [disableOpen, setDisableOpen] = useState(false);

  const [purgeOpen, setPurgeOpen] = useState(false);
  const [purgeTyped, setPurgeTyped] = useState("");

  const [deleting, setDeleting] = useState<SampleView | null>(null);
  const [opened, setOpened] = useState<{ id: string; row: ForensicReportRow | null; error: string | null } | null>(null);

  const [raw, setRaw] = useState("");
  const [ingestNote, setIngestNote] = useState<string | null>(null);

  async function toggleCollection(next: boolean) {
    setBusy("collect");
    setError(null);
    const res = await setForensicCollection(organizationId, domain.id, next);
    setBusy(null);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setCollecting(res.data.domain.collectForensicReports);
    toast({ title: next ? `Collecting samples for ${domain.name}` : `Stopped collecting for ${domain.name}`, body: next ? undefined : "Nothing already stored was deleted.", tone: "ok" });
    router.refresh();
  }

  async function setNamed(retain: boolean) {
    setBusy("name");
    setError(null);
    const res = await setForensicIdentityRetention(organizationId, domain.id, {
      retainForensicPii: retain,
      confirmLegalBasis: retain ? legalBasis : false,
      confirmNamePurge: !retain,
    });
    setBusy(null);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setNaming(res.data.domain.retainForensicPii);
    setEnableOpen(false);
    setDisableOpen(false);
    setLegalBasis(false);
    toast({
      title: retain ? "Recipient names are kept from now on" : "Recipient names destroyed",
      body: retain ? undefined : `${res.data.purgedIdentities} sample${res.data.purgedIdentities === 1 ? "" : "s"} had names removed. Pseudonyms remain.`,
      tone: "ok",
    });
    router.refresh();
  }

  async function purge() {
    setBusy("purge");
    const res = await purgeDomainForensics(organizationId, domain.id);
    setBusy(null);
    if (!res.ok) {
      setError(res.error);
      setPurgeOpen(false);
      return;
    }
    setPurgeOpen(false);
    setPurgeTyped("");
    toast({ title: `${res.data.deleted} sample${res.data.deleted === 1 ? "" : "s"} deleted for ${domain.name}`, tone: "ok" });
    router.refresh();
  }

  async function removeOne() {
    if (!deleting) return;
    setBusy("delete");
    const res = await deleteForensicReport(organizationId, deleting.id);
    setBusy(null);
    if (!res.ok && res.status !== 404) {
      setError(res.error);
      setDeleting(null);
      return;
    }
    setDeleting(null);
    if (opened?.id === deleting.id) setOpened(null);
    router.refresh();
  }

  async function open(id: string) {
    if (opened?.id === id) {
      setOpened(null);
      return;
    }
    setOpened({ id, row: null, error: null });
    const res = await fetchForensicReport(organizationId, id);
    setOpened(res.ok ? { id, row: res.data, error: null } : { id, row: null, error: res.error.message ?? "The sample could not be read." });
  }

  async function ingest() {
    if (!raw.trim()) return;
    setBusy("ingest");
    setIngestNote(null);
    setError(null);
    const res = await ingestForensicReport(organizationId, domain.id, raw);
    setBusy(null);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setRaw("");
    setIngestNote(res.data.duplicate ? "That sample was already stored; nothing was added." : "Sample stored.");
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-10">
      <label className="flex flex-wrap items-center gap-3">
        <span className="text-meta font-semibold text-fg-2">Domain</span>
        <Select value={domain.id} onChange={(e) => router.push(forensicsHref({ domain: e.target.value }))} className="min-w-[300px]">
          {domains.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name} ({d.clientName})
            </option>
          ))}
        </Select>
      </label>

      <Panel
        id="fx-collect"
        title="Collecting samples"
        why={
          retention
            ? `Samples are kept ${retention.days} days. Recipient names, when kept, go after ${retention.piiDays} days.`
            : "Receivers send a sample of a failing message when the domain's record asks for one."
        }
        aside={
          canCollect && state ? (
            <span className="flex items-center gap-2 text-ui text-fg-2">
              <Switch checked={collecting} onChange={toggleCollection} busy={busy === "collect"} label={`Collect samples for ${domain.name}`} />
              {collecting ? "Collecting" : "Off"}
            </span>
          ) : null
        }
      >
        {state === null ? (
          <Notice tone="warn" title="This domain's collection settings could not be read">
            Whether samples are being collected is unknown just now. Reload to try again.
          </Notice>
        ) : !state.rufPublished ? (
          <Notice
            tone="info"
            title={`${domain.name} does not ask for samples`}
            action={
              <ButtonLink href={onboardingHref(domain.slug)} size="sm">
                Open its setup
              </ButtonLink>
            }
          >
            Its DMARC record has no <code className="data">ruf=</code> address, so receivers send none.
            {state.forensicAddress ? (
              <>
                {" "}
                The record on its setup page adds <code className="data text-fg">{state.forensicAddress}</code>.
              </>
            ) : null}
          </Notice>
        ) : (
          <p className="text-ui text-fg-2">
            {collecting
              ? "Samples that arrive for this domain are stored. Turning this off stops new ones and deletes nothing."
              : "Samples that arrive are not stored while this is off."}
          </p>
        )}
      </Panel>

      <Panel
        id="fx-names"
        title="Recipient names"
        why="By default a sample's recipients, subject and sender are replaced with pseudonyms. Keeping the real values is personal data about people outside your workspace."
        aside={naming ? <Badge tone="warn">Kept</Badge> : <Badge tone="neutral">Pseudonyms only</Badge>}
      >
        {namedEntitled === false ? (
          <UpgradeNotice message="Keeping recipient names is not included in this workspace's plan." feature="reports.forensicNamed" />
        ) : !canIdentify ? (
          <p className="text-ui text-fg-2">Owners and admins decide this, and only they see names when they are kept.</p>
        ) : naming ? (
          <div className="flex flex-col gap-2">
            <p className="text-ui text-fg-2">Names are kept for new samples of {domain.name}, and shown to owners and admins.</p>
            <div>
              <Button variant="danger" onClick={() => setDisableOpen(true)}>
                Stop keeping names and destroy them
              </Button>
            </div>
          </div>
        ) : (
          <div>
            <Button onClick={() => setEnableOpen(true)}>Keep recipient names…</Button>
          </div>
        )}
      </Panel>

      <Panel
        id="fx-list"
        title="Samples"
        aside={
          paging.onLaterPage ? (
            <Link href={forensicsHref({ domain: domain.id })} className="link">
              Newest first
            </Link>
          ) : null
        }
      >
        {samples === null ? (
          <Notice tone="warn" title="The samples could not be read">
            This is not the same as there being none. Reload to try again.
          </Notice>
        ) : (
          <Table caption={`Forensic samples for ${domain.name}`} minWidth={760} dense>
            <THead>
              <tr>
                <Th>Received</Th>
                <Th>Sent from</Th>
                <Th>SPF</Th>
                <Th>DKIM</Th>
                <Th>Receiver did</Th>
                <Th numeric>Recipients</Th>
                <Th>Names</Th>
                <Th align="right">
                  <span className="sr-only">Actions</span>
                </Th>
              </tr>
            </THead>
            <TBody>
              {samples.length === 0 ? (
                <TEmptyRow colSpan={8}>No sample stored for {domain.name}.</TEmptyRow>
              ) : (
                samples.map((s) => (
                  <SampleRow
                    key={s.id}
                    s={s}
                    opened={opened?.id === s.id ? opened : null}
                    onOpen={() => open(s.id)}
                    onDelete={canPurge ? () => setDeleting(s) : undefined}
                  />
                ))
              )}
            </TBody>
          </Table>
        )}
        {paging.hasMore && paging.nextCursor ? (
          <div>
            <ButtonLink href={forensicsHref({ domain: domain.id, cursor: paging.nextCursor })} size="sm">
              Older samples
            </ButtonLink>
          </div>
        ) : null}
        {canCollect ? (
          <details className="mt-2 rounded-ctl border border-rule px-4 py-3">
            <summary className="cursor-pointer text-ui font-semibold text-fg">Add a sample by hand</summary>
            <div className="mt-3 flex flex-col gap-3">
              <p className="text-meta text-fg-3">
                For a sample that reached you some other way. Paste the whole raw message, headers included, as the receiver
                sent it.
              </p>
              <Textarea mono rows={6} value={raw} onChange={(e) => setRaw(e.target.value)} placeholder="Received: from …" />
              <div className="flex items-center gap-3">
                <Button size="sm" onClick={ingest} busy={busy === "ingest"} busyLabel="Storing the sample" disabled={!raw.trim()}>
                  Store sample
                </Button>
                {ingestNote ? <span className="text-meta text-ok">{ingestNote}</span> : null}
              </div>
            </div>
          </details>
        ) : null}
      </Panel>

      <ActionRefusal error={error} />

      {canPurge && (paging.onLaterPage || (samples !== null && samples.length > 0)) ? (
        <DangerZone
          title={`Delete every sample for ${domain.name}`}
          consequence={
            <p>
              Every stored sample for this domain is deleted now, pseudonyms and names alike. There is no grace period and no
              undo. Collection carries on if it is on; this clears what is stored.
            </p>
          }
        >
          <div>
            <Button variant="danger" onClick={() => setPurgeOpen(true)}>
              Delete all samples…
            </Button>
          </div>
        </DangerZone>
      ) : null}

      <Dialog
        open={enableOpen}
        onClose={() => setEnableOpen(false)}
        title={`Keep recipient names for ${domain.name}?`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEnableOpen(false)}>
              Keep pseudonyms only
            </Button>
            <Button variant="primary" onClick={() => setNamed(true)} disabled={!legalBasis} busy={busy === "name"} busyLabel="Saving">
              Keep names
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3 text-ui text-fg-2">
          <p>
            New samples will keep the real recipient addresses, subject lines and senders, for{" "}
            {retention ? `${retention.piiDays} days` : "a limited time"}. Owners and admins will see them. These are people
            outside your workspace, so you need a lawful reason to hold them.
          </p>
          <Checkbox checked={legalBasis} onChange={(e) => setLegalBasis(e.target.checked)} label="This workspace has a lawful basis to keep this personal data, and I am entitled to confirm it." />
        </div>
      </Dialog>

      <ConfirmDialog
        open={disableOpen}
        onClose={() => setDisableOpen(false)}
        onConfirm={() => setNamed(false)}
        title="Destroy the stored names?"
        body={
          <p>
            Every stored recipient address, subject line and sender for {domain.name} is deleted permanently, now. The
            pseudonymised samples stay. Turning names back on later only affects new samples.
          </p>
        }
        confirmLabel="Destroy names"
        busy={busy === "name"}
        danger
      />

      <Dialog
        open={purgeOpen}
        onClose={() => setPurgeOpen(false)}
        title={`Delete every sample for ${domain.name}?`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPurgeOpen(false)}>
              Keep them
            </Button>
            <Button variant="danger" onClick={purge} disabled={purgeTyped.trim().toLowerCase() !== domain.name.toLowerCase()} busy={busy === "purge"} busyLabel="Deleting">
              Delete all samples
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3 text-ui text-fg-2">
          <p>This cannot be undone. The evidence in these samples is gone for good, for everyone in the workspace.</p>
          <Field label={<>Type <code className="data text-fg">{domain.name}</code> to confirm</>}>
            <Input mono value={purgeTyped} onChange={(e) => setPurgeTyped(e.target.value)} autoComplete="off" spellCheck={false} />
          </Field>
        </div>
      </Dialog>

      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={removeOne}
        title="Delete this sample?"
        body={deleting ? <p>The sample received {deleting.receivedLabel} from {deleting.sourceIp} is deleted permanently.</p> : null}
        confirmLabel="Delete sample"
        busy={busy === "delete"}
        danger
      />
    </div>
  );
}

function SampleRow({
  s,
  opened,
  onOpen,
  onDelete,
}: {
  s: SampleView;
  opened: { row: ForensicReportRow | null; error: string | null } | null;
  onOpen: () => void;
  onDelete?: () => void;
}) {
  const r = opened?.row;
  return (
    <>
      <Tr>
        <Td className="whitespace-nowrap text-meta">{s.receivedLabel}</Td>
        <Td mono className="text-meta">
          {s.sourceIp}
        </Td>
        <Td>
          <Badge tone={pass(s.spf)}>{s.spf ?? "—"}</Badge>
        </Td>
        <Td>
          <Badge tone={pass(s.dkim)}>{s.dkim ?? "—"}</Badge>
        </Td>
        <Td className="text-meta">{s.disposition ?? <span className="text-fg-4">not reported</span>}</Td>
        <Td numeric>{s.recipients}</Td>
        <Td className="text-meta">{s.identity === "stored" ? "Kept" : s.identity === "withheld" ? "Kept, hidden from you" : "Pseudonyms"}</Td>
        <Td align="right" className="whitespace-nowrap">
          <button type="button" className="link text-meta" onClick={onOpen} aria-expanded={Boolean(opened)}>
            {opened ? "Close" : "Open"}
          </button>
          {onDelete ? (
            <button type="button" className="ml-3 text-meta font-semibold text-fail hover:underline" onClick={onDelete}>
              Delete
            </button>
          ) : null}
        </Td>
      </Tr>
      {opened ? (
        <tr className="border-b border-rule bg-paper-3/50">
          <td colSpan={8} className="px-3 py-3">
            {opened.error ? (
              <p className="text-ui text-fail">{opened.error}</p>
            ) : !r ? (
              <p className="text-ui text-fg-3">Reading the sample…</p>
            ) : (
              <div className="grid gap-4 [animation:hb-fade_120ms_ease-out] md:grid-cols-2">
                <KeyValue
                  labelWidth={150}
                  rows={[
                    ["Report type", r.feedbackType],
                    ["Original sent", instantLabel(r.originalMessageDate)],
                    ["Reported by", r.reportingMta ? <code key="m" className="data">{r.reportingMta}</code> : <span key="m" className="text-fg-3">not reported</span>],
                    ["Delivery", [r.deliveryAction, r.deliveryStatus].filter(Boolean).join(" · ") || <span key="d" className="text-fg-3">not reported</span>],
                    r.authResults && r.authResults.length > 0
                      ? [
                          "Checks",
                          <ul key="a" className="flex flex-col">
                            {r.authResults.map((a, i) => (
                              <li key={i} className="data text-meta">
                                {a.type} {a.domain ?? ""} {a.selector ? `(${a.selector})` : ""}: {a.result}
                              </li>
                            ))}
                          </ul>,
                        ]
                      : null,
                    r.diagnosticCodes && r.diagnosticCodes.length > 0 ? ["Receiver said", <span key="c" className="data text-meta">{r.diagnosticCodes.join("; ")}</span>] : null,
                  ]}
                />
                <KeyValue
                  labelWidth={150}
                  rows={[
                    [
                      "Recipients",
                      r.recipientAddresses && r.recipientAddresses.length > 0 ? (
                        <span key="r" className="data text-meta">{r.recipientAddresses.join(", ")}</span>
                      ) : (
                        <span key="r" className="data text-meta text-fg-3">{(r.recipientPseudonyms ?? []).join(", ") || "none listed"}</span>
                      ),
                    ],
                    ["Subject", r.subjectLine ?? <span key="s" className="data text-meta text-fg-3">{r.subjectPseudonym ?? "not reported"}</span>],
                    ["Sender", r.envelopeFrom ?? <span key="e" className="data text-meta text-fg-3">{r.envelopeFromPseudonym ?? "not reported"}</span>],
                    ["Deleted on its own", instantLabel(r.retentionExpiresAt)],
                  ]}
                />
                {r.piiWithheld ? (
                  <p className="text-meta text-fg-3 md:col-span-2">Names are kept for this sample but your role sees pseudonyms.</p>
                ) : null}
              </div>
            )}
          </td>
        </tr>
      ) : null}
    </>
  );
}
