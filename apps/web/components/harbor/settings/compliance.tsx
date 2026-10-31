"use client";

/**
 * compliance.tsx — the two things you hand a client's auditor: a public Trust
 * Center page, and a signed PDF of the client's DMARC evidence.
 *
 * The pack's value is its fingerprint: the SHA-256 of exactly the bytes
 * issued, which anyone can check on the public verify page. So issuing leads
 * to the fingerprint and the verify link, not to a download spinner, and the
 * page says what the fingerprint proves and that it proves nothing more.
 *
 * Withdrawing a Trust Center is immediate and the address never comes back:
 * publishing again mints a new one. The confirmation says so.
 *
 * Beside the issue button, the pack's route is drawn as four stops (issued,
 * fingerprinted, sent, checked), so the person handing it over can explain to
 * the auditor what the fingerprint is for.
 *
 * Test hooks: pack-issue, pack-issued, pack-fingerprint, pack-copy.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { createTrustCenter, issueCompliancePack, revokeTrustCenter } from "@/lib/ops-client";
import type { FeatureStatus } from "@/lib/entitlements";
import { ActionRefusal, type ActionError } from "@/components/harbor/plan-refusal";
import { Button, ButtonLink } from "@/components/ui/button";
import { CopyButton, CopyValue } from "@/components/ui/copy";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Select } from "@/components/ui/field";
import { External } from "@/components/ui/icons";
import { UpgradeNotice } from "@/components/ui/states";
import { Table, TBody, Td, TEmptyRow, Th, THead, Tr } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { Panel, RouteColumn, StateWord } from "./parts";

/** The pack just issued: its fingerprint, the verify link, and a second copy. */
function PackResult({
  issued,
  error,
  verifyHref,
}: {
  issued: { reference: string; sha256: string; filename: string; href: string } | null;
  error: ActionError | null;
  verifyHref: (reference: string) => string;
}) {
  return (
    <>
      <ActionRefusal error={error} />
      {issued ? (
        <div data-testid="pack-issued" className="flex flex-col gap-3 rounded-sheet border-2 border-fg px-5 py-4">
          <div className="flex flex-wrap items-baseline gap-x-3">
            <StateWord shape="square" tone="ok">
              Issued
            </StateWord>
            <code className="data text-ui text-fg-2">{issued.reference}</code>
          </div>
          <div>
            <p className="legend">SHA-256 fingerprint</p>
            <div className="mt-1 flex items-start gap-2 rounded-ctl border border-rule bg-paper-3 py-1.5 pl-2.5 pr-1.5">
              <code data-testid="pack-fingerprint" className="data min-w-0 flex-1 break-all pt-[3px] text-meta text-fg">
                {issued.sha256}
              </code>
              <CopyButton value={issued.sha256} label="Copy fingerprint" testId="pack-copy" />
            </div>
          </div>
          <p className="text-ui text-fg-2">
            Send the fingerprint with the PDF. Anyone can check it on the{" "}
            <Link href={verifyHref(issued.reference)} className="link" target="_blank">
              public verify page
            </Link>
            : a match proves the file is the one issued here, unchanged. It proves nothing more about the domains than the
            PDF itself says.
          </p>
          <div>
            <a href={issued.href} download={issued.filename} className="link text-ui font-semibold">
              Save the PDF again
            </a>
          </div>
        </div>
      ) : null}
    </>
  );
}

export interface PackView {
  id: string;
  reference: string;
  hash: string;
  issuedLabel: string;
  asOfLabel: string;
  superseded: boolean;
}

export function CompliancePicker({ clients, selected }: { clients: Array<{ id: string; name: string }>; selected: string }) {
  const router = useRouter();
  return (
    <label className="flex flex-wrap items-center gap-3">
      <span className="text-meta font-semibold text-fg-2">Client</span>
      <Select
        value={selected}
        onChange={(e) => router.push(`/settings/compliance?client=${encodeURIComponent(e.target.value)}`)}
        className="min-w-[260px]"
      >
        {clients.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </Select>
    </label>
  );
}

export function ComplianceBoard({
  organizationId,
  clientId,
  clientName,
  packs,
  trustUrl,
  packFeature,
  trustFeature,
  canManage,
}: {
  organizationId: string;
  clientId: string;
  clientName: string;
  packs: PackView[] | null;
  /** Absolute public address, or null when not published (or unreadable). */
  trustUrl: string | null;
  packFeature: FeatureStatus;
  trustFeature: FeatureStatus;
  canManage: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [issuing, setIssuing] = useState(false);
  const [issued, setIssued] = useState<{ reference: string; sha256: string; filename: string; href: string } | null>(null);
  const [packError, setPackError] = useState<ActionError | null>(null);
  const [trustBusy, setTrustBusy] = useState(false);
  const [trustError, setTrustError] = useState<ActionError | null>(null);
  const [withdrawOpen, setWithdrawOpen] = useState(false);

  async function issue() {
    setIssuing(true);
    setPackError(null);
    const res = await issueCompliancePack(organizationId, clientId);
    setIssuing(false);
    if (!res.ok) {
      setPackError(res.error);
      return;
    }
    const href = URL.createObjectURL(res.data.bytes);
    // The browser saves it now; the link stays for a second copy.
    const a = document.createElement("a");
    a.href = href;
    a.download = res.data.filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setIssued({ reference: res.data.reference, sha256: res.data.sha256, filename: res.data.filename, href });
    router.refresh();
  }

  async function publish() {
    setTrustBusy(true);
    setTrustError(null);
    const res = await createTrustCenter(organizationId, clientId);
    setTrustBusy(false);
    if (!res.ok) {
      setTrustError(res.error);
      return;
    }
    toast({ title: `${clientName}'s Trust Center is published`, tone: "ok" });
    router.refresh();
  }

  async function withdraw() {
    setTrustBusy(true);
    const res = await revokeTrustCenter(organizationId, clientId);
    setTrustBusy(false);
    setWithdrawOpen(false);
    if (!res.ok) {
      setTrustError(res.error);
      return;
    }
    toast({ title: "Trust Center withdrawn", body: "The old address no longer opens.", tone: "ok" });
    router.refresh();
  }

  const verifyHref = (reference: string) => `/verify?reference=${encodeURIComponent(reference)}`;

  return (
    <div className="flex flex-col gap-14">
      <Panel
        id="cp-pack"
        title="Evidence pack"
        why={`A PDF of ${clientName}'s DMARC evidence as of today, fingerprinted so an auditor can check it was not altered. Issuing a new one marks the previous one superseded.`}
      >
        {packFeature === false ? (
          <UpgradeNotice message="Compliance packs are not included in this workspace's plan." feature="reports.compliancePack" />
        ) : (
          <div className="grid gap-x-12 gap-y-6 md:grid-cols-[minmax(0,1fr)_minmax(0,17rem)]">
            <div className="flex min-w-0 flex-col gap-4">
              {canManage ? (
                <div>
                  <Button variant="primary" onClick={issue} busy={issuing} busyLabel="Issuing the pack" data-testid="pack-issue">
                    Issue a pack for {clientName}
                  </Button>
                </div>
              ) : (
                <p className="text-ui text-fg-2">An owner or admin can issue packs.</p>
              )}
              {canManage ? <PackResult issued={issued} error={packError} verifyHref={verifyHref} /> : null}
            </div>
            <figure className="flex flex-col gap-3 md:border-l md:border-rule md:pl-6">
              <figcaption className="text-ui">
                <span className="font-bold text-fg">How an auditor checks it</span>
              </figcaption>
              <RouteColumn
                label="How an auditor checks an evidence pack"
                stops={[
                  { key: "issue", shape: "origin", name: "Issued here", kind: "a PDF of the evidence today" },
                  { key: "print", shape: "station", name: "Fingerprinted", kind: "SHA-256 of exactly those bytes" },
                  { key: "send", shape: "station", name: "Sent with the PDF", kind: "by you, to the auditor" },
                  { key: "check", shape: "terminus", name: "Checked on the public verify page", kind: "a match means unchanged" },
                ]}
              />
            </figure>
          </div>
        )}

        <h3 className="mt-4 text-ui font-bold text-fg">Issued for {clientName}</h3>
        {packs === null ? (
          <p className="text-ui text-fg-3">The list of issued packs could not be read. This is not the same as there being none.</p>
        ) : (
          <Table caption={`Compliance packs issued for ${clientName}`} minWidth={680} dense>
            <THead>
              <tr>
                <Th>Reference</Th>
                <Th>Issued</Th>
                <Th>Evidence as of</Th>
                <Th>Fingerprint</Th>
                <Th align="right">
                  <span className="sr-only">Verify</span>
                </Th>
              </tr>
            </THead>
            <TBody>
              {packs.length === 0 ? (
                <TEmptyRow colSpan={5}>No pack has been issued for this client.</TEmptyRow>
              ) : (
                packs.map((p) => (
                  <Tr key={p.id}>
                    <Td className="text-meta">
                      <span className="data text-fg">{p.reference}</span>
                      <span className="ml-2.5 inline-flex align-baseline">
                        {p.superseded ? (
                          <StateWord shape="closed" tone="void" size="meta">
                            superseded
                          </StateWord>
                        ) : (
                          <StateWord shape="square" tone="ok" size="meta">
                            current
                          </StateWord>
                        )}
                      </span>
                    </Td>
                    <Td className="whitespace-nowrap text-meta">{p.issuedLabel}</Td>
                    <Td className="whitespace-nowrap text-meta">{p.asOfLabel}</Td>
                    <Td mono className="text-meta text-fg-3" title={p.hash}>
                      {p.hash.slice(0, 12)}…
                    </Td>
                    <Td align="right">
                      <Link href={verifyHref(p.reference)} className="link text-meta" target="_blank">
                        Verify
                      </Link>
                    </Td>
                  </Tr>
                ))
              )}
            </TBody>
          </Table>
        )}
      </Panel>

      <Panel
        id="cp-trust"
        title="Trust Center"
        why={`A public page about how ${clientName}'s data is held here: what is kept, who can read it, the sub-processors, and the erasures done. Anyone with the address can open it; it is not listed by search engines.`}
        aside={
          trustUrl ? (
            <StateWord shape="square" tone="ok">
              Published
            </StateWord>
          ) : (
            <StateWord shape="closed" tone="void">
              Not published
            </StateWord>
          )
        }
      >
        {trustUrl ? (
          <div className="flex flex-col gap-3">
            <CopyValue value={trustUrl} label="Trust Center address" className="max-w-[640px]" />
            <div className="flex flex-wrap items-center gap-3">
              <ButtonLink href={trustUrl} size="sm" target="_blank">
                Open it <External size={12} />
              </ButtonLink>
              {canManage ? (
                <Button size="sm" variant="ghost" className="text-fail hover:text-fail" onClick={() => setWithdrawOpen(true)}>
                  Withdraw the page
                </Button>
              ) : null}
            </div>
          </div>
        ) : trustFeature === false ? (
          <UpgradeNotice message="The Trust Center is not included in this workspace's plan." feature="trust.center" />
        ) : canManage ? (
          <div>
            <Button variant="primary" onClick={publish} busy={trustBusy} busyLabel="Publishing">
              Publish {clientName}&rsquo;s Trust Center
            </Button>
          </div>
        ) : (
          <p className="text-ui text-fg-2">An owner or admin can publish it.</p>
        )}
        <ActionRefusal error={trustError} />
      </Panel>

      <ConfirmDialog
        open={withdrawOpen}
        onClose={() => setWithdrawOpen(false)}
        onConfirm={withdraw}
        title={`Withdraw ${clientName}'s Trust Center?`}
        body={
          <p>
            The page stops opening at once, for everyone who has the address. Publishing again creates a new address; this
            one never comes back, so anyone who needs it must be sent the new one.
          </p>
        }
        confirmLabel="Withdraw the page"
        busy={trustBusy}
        danger
      />
    </div>
  );
}
