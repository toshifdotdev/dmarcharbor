"use client";

/**
 * forensics-client.tsx — forensic collection, named-recipient retention, the
 * stored reports, and the two ways to destroy them.
 *
 * WHY THIS IS ONE DOMAIN AT A TIME
 *
 * Every forensic route in the API is scoped to a domain, except the two that
 * name a single report id. There is no workspace-wide list, so a workspace-level
 * index would have to fan out one request per domain, would show each domain's
 * first page side by side without saying so, and would then need a second
 * decision about what "all of it" means when the purges are per domain anyway.
 * The section is in Settings because that is where licensing and retention live;
 * its content is one domain, chosen at the top, and every control below applies
 * to that domain and names it.
 *
 * TWO LICENCES, NOT ONE
 *
 * `reports.forensic` gates the section: the list route and the manual ingest
 * route both carry requireFeature('reports.forensic'), and without it there is
 * nothing to read and nothing to store.
 *
 * `reports.forensicNamed` gates one control only: PATCH .../forensics/identities
 * carries requireFeature('reports.forensicNamed') and nothing else in the file
 * does. It is a different and more expensive licence, so it is gated on its own
 * and says so in words rather than hiding a control or quietly offering one that
 * would 402. A workspace on Fairway holds reports.forensic and not
 * reports.forensicNamed: it gets collection, retention, the stored reports and
 * both purges, and it is told the named-recipient switch is not part of its plan.
 *
 * WHAT MUTATES EVIDENCE, STATED ON THE SCREEN
 *
 * Four of the five controls here are additive or reversible and say so:
 * collection on or off stops and starts collection without deleting anything,
 * ingest adds a row, and opening a report reads it.
 *
 * Two are irreversible and neither is ever a bare button:
 *
 *   - turning OFF named-recipient retention destroys the stored recipient
 *     addresses, subject lines and envelope senders for every report of the
 *     domain. The pseudonyms stay, so the evidence survives as evidence, but the
 *     part that identified a person does not come back.
 *   - erasing a report, or a domain's whole forensic history, deletes rows. No
 *     grace period, no undo. The audit trail records that somebody did it, which
 *     is the only thing that survives.
 *
 * THREE STATES, NEVER TWO
 *
 * Every read here separates loaded, empty and failed. An empty report list is a
 * claim about a domain; a failed list is a claim about the network, and
 * rendering the second as the first is how an investigation concludes there is
 * nothing there. The 403 and the 402 are split out too, because a role refusal
 * and a plan refusal are different answers and both are real.
 */

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ActionButton } from "@/components/action-button";
import { ConfirmAction } from "@/components/confirm-action";
import { EmptyState, ErrorState, LoadingState } from "@/components/data-states";
import { EntitlementNotice } from "@/components/entitlement-gate";
import {
  deleteForensicReport,
  fetchForensicReport,
  ingestForensicReport,
  purgeDomainForensics,
  setForensicCollection,
  setForensicIdentityRetention,
} from "@/lib/forensics-client";
import { forensicsHref } from "@/lib/route-hrefs";
import { instantLabel } from "@/lib/instant";
import type {
  ApiErrorBody,
  ForensicReportRow,
  ForensicRetentionSummary,
} from "@/lib/types";

// ─── what the server hands down ───────────────────────────────────────────────

export interface ForensicsDomainOption {
  id: string;
  name: string;
  clientName: string;
  status: string;
}

/** Why a read did not produce rows. Never collapsed into "empty". */
export type ForensicsReadStatus = "ok" | "failed" | "forbidden" | "unlicensed";

export interface ForensicReportsView {
  status: ForensicsReadStatus;
  rows: ForensicReportListRow[];
  /** The API's own words for the refusal, quoted rather than replaced. */
  detail: string | null;
  retention: ForensicRetentionSummary | null;
  /** The API has more of this domain's reports than were loaded. */
  hasMore: boolean;
  /** The cursor for the next page, or null when this is the whole list. */
  nextCursor: string | null;
}

/**
 * One report as the list renders it, with its timestamp already written.
 *
 * Three identity states rather than one boolean, because they are three different
 * facts about the same report: identities stored and visible, identities stored
 * but withheld from this caller's role, and identities never stored at all. A
 * single "pii: yes/no" would make the second of those look like the third.
 */
export interface ForensicReportListRow {
  id: string;
  reportedDomain: string;
  sourceIp: string;
  sourcePort: number | null;
  disposition: string | null;
  deliveryAction: string | null;
  dkimResult: string | null;
  spfResult: string | null;
  recipientCount: number;
  receivedLabel: string;
  identities: "stored" | "withheld" | "pseudonymous";
}

export interface ForensicDomainStateView {
  status: "ok" | "failed";
  collectionEnabled: boolean;
  identityRetentionEnabled: boolean;
  rufConfigured: boolean;
  /** The address a ruf= tag should point at, as the API generated it. */
  forensicAddress: string | null;
  /** The API's own sentence about this domain's forensic reporting, quoted. */
  stepDetail: string | null;
}

// ─── the section ──────────────────────────────────────────────────────────────

export function ForensicsPanel({
  organizationId,
  domains,
  domainsFailed,
  selectedDomain,
  ignoredDomain,
  namedEntitled,
  planLabel,
  reports,
  domainState,
}: {
  organizationId: string;
  domains: ForensicsDomainOption[];
  domainsFailed: boolean;
  selectedDomain: ForensicsDomainOption | null;
  /** A ?domain= value that is no longer in this workspace. */
  ignoredDomain: string | null;
  namedEntitled: boolean;
  /** Shown when the workspace lacks a licence, because "your plan" is more use
   *  to a reader than "Fairway". Null when entitlements could not be read. */
  planLabel: string | null;
  reports: ForensicReportsView;
  domainState: ForensicDomainStateView;
}) {
  return (
    <div className="flex flex-col gap-5">
      <DomainPicker domains={domains} selectedDomain={selectedDomain} domainsFailed={domainsFailed} />

      {ignoredDomain ? (
        <p
          role="status"
          className="rounded-[2px] border px-4 py-2.5 text-[12.5px]"
          style={{
            borderColor: "var(--color-unverified)",
            background: "var(--color-unverified-soft)",
            color: "var(--color-ink-2)",
          }}
          data-testid="forensics-ignored-domain"
        >
          That domain is not in this workspace any more, so the first one is
          shown instead. Every control below applies to whichever domain is
          selected.
        </p>
      ) : null}

      {selectedDomain === null ? (
        <EmptyState
          title={domainsFailed ? "The domain list could not be read" : "No domains to collect for"}
          description={
            domainsFailed
              ? "The API did not answer, so nothing here is known about which domains exist. That is a failed read, not an empty workspace."
              : "Forensic collection is a per domain setting, and this workspace has no domains yet. Add a client domain and verify it: a domain whose ownership has not been proven is never scanned or collected for."
          }
        />
      ) : (
        <>
          <CollectionPanel
            organizationId={organizationId}
            domain={selectedDomain}
            state={domainState}
          />
          <IdentityPanel
            organizationId={organizationId}
            domain={selectedDomain}
            state={domainState}
            retention={reports.retention}
            namedEntitled={namedEntitled}
            planLabel={planLabel}
          />
          <ReportList
            organizationId={organizationId}
            domain={selectedDomain}
            reports={reports}
          />
          {reports.status === "ok" && reports.rows.length > 0 ? (
            <DomainPurgePanel organizationId={organizationId} domain={selectedDomain} />
          ) : null}
          <IngestPanel
            organizationId={organizationId}
            domain={selectedDomain}
            state={domainState}
          />
        </>
      )}
    </div>
  );
}

/**
 * The domain the controls apply to.
 *
 * A link, not a client-side filter: changing it re-reads the API for a different
 * domain, which is the only way the list below can honestly describe one domain's
 * reports. The cursor is dropped on the way, because a page of one domain's
 * reports cannot be paged into another domain's.
 */
function DomainPicker({
  domains,
  selectedDomain,
  domainsFailed,
}: {
  domains: ForensicsDomainOption[];
  selectedDomain: ForensicsDomainOption | null;
  domainsFailed: boolean;
}) {
  const router = useRouter();

  return (
    <label className="flex max-w-md flex-col gap-1.5">
      <span className="label">Domain</span>
      <select
        value={selectedDomain?.id ?? ""}
        disabled={domains.length === 0}
        onChange={(e) => router.replace(forensicsHref({ domain: e.target.value }))}
        data-testid="forensics-domain-picker"
        style={SELECT_STYLE}
      >
        {domains.length === 0 ? <option value="">No domains in this workspace</option> : null}
        {domains.map((domain) => (
          <option key={domain.id} value={domain.id}>
            {domain.name} · {domain.clientName}
          </option>
        ))}
      </select>
      {domainsFailed ? (
        <span className="text-[12px]" style={{ color: "var(--color-unverified)" }}>
          The domain list did not load, so this picker may be missing domains.
        </span>
      ) : (
        <span className="text-[12px]" style={{ color: "var(--color-ink-3)" }}>
          Every control on this page applies to this domain and nothing else.
        </span>
      )}
    </label>
  );
}

// ─── collection ───────────────────────────────────────────────────────────────

/**
 * Whether forensic reports are collected for this domain at all.
 *
 * This switch is reversible and deletes nothing, which is why it is a plain
 * button rather than a ConfirmAction. Turning it off stops the mailbox from
 * keeping anything new; every report already stored stays exactly as it is,
 * identities included. Erasing stored reports is a different control, further
 * down, and it is confirmed.
 *
 * Note also that the switch is not sufficient on its own. The ingestion path
 * checks the domain's published record as well: the API refuses a report for a
 * domain that publishes no ruf= address, because there would be nowhere for a
 * reporter to send it. So this panel states the two facts separately rather than
 * implying that collection being on means reports will arrive.
 */
function CollectionPanel({
  organizationId,
  domain,
  state,
}: {
  organizationId: string;
  domain: ForensicsDomainOption;
  state: ForensicDomainStateView;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<ApiErrorBody["error"] | null>(null);

  async function toggle(enabled: boolean) {
    setBusy(true);
    setNotice(null);
    setError(null);
    const res = await setForensicCollection(organizationId, domain.id, enabled);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setNotice(
      enabled
        ? `Collection is now on for ${domain.name}. Reports are stored with pseudonymous recipients${
            res.data.domain.rufConfigured
              ? ", and this domain publishes a ruf= address for them to arrive at."
              : ", but this domain publishes no ruf= address, so nothing will arrive until the record is republished."
          }`
        : `Collection is off for ${domain.name}. No new forensic report will be stored. Nothing already stored was touched: the reports held for this domain are unchanged, recipient identities included.`,
    );
    router.refresh();
  }

  return (
    <section
      className="lift rounded-[2px] border"
      style={{ background: "var(--color-surface)", borderColor: "var(--color-line)" }}
      data-testid="forensics-collection"
    >
      <header className="border-b px-5 py-3.5" style={{ borderColor: "var(--color-line)" }}>
        <h2 className="text-[16.5px] font-semibold tracking-[-0.012em]">
          Forensic report collection
        </h2>
        <p className="mt-1 text-[13px]" style={{ color: "var(--color-ink-2)" }}>
          Whether per-message forensic reports for {domain.name} are kept when a
          reporter sends one. Reversible, and it deletes nothing.
        </p>
      </header>

      <div className="px-5 py-4">
        {state.status === "failed" ? (
          <ErrorState
            what="this domain's collection setting"
            detail={`Nothing is known about whether collection is on for ${domain.name}. An unread setting is not an off switch, and this panel will not change a setting it could not read.`}
          />
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-baseline gap-x-5 gap-y-2">
              <span
                className="num text-[11.5px] font-semibold tracking-[0.12em] uppercase"
                style={{
                  color: state.collectionEnabled ? "var(--color-pass)" : "var(--color-unmeasured)",
                }}
                data-testid="forensics-collection-state"
              >
                {state.collectionEnabled ? "collecting" : "not collecting"}
              </span>
              <span
                className="num text-[12.5px]"
                style={{ color: state.rufConfigured ? "var(--color-ink-2)" : "var(--color-unverified)" }}
              >
                {state.rufConfigured
                  ? "the published record carries a ruf= address"
                  : "the published record carries no ruf= address"}
              </span>
            </div>

            {state.stepDetail ? (
              <p className="text-[13px]" style={{ color: "var(--color-ink-2)" }}>
                {state.stepDetail}
              </p>
            ) : null}

            {!state.rufConfigured ? (
              <p
                role="status"
                className="rounded-[2px] border px-3 py-2.5 text-[12.5px]"
                style={{
                  borderColor: "var(--color-unverified)",
                  background: "var(--color-unverified-soft)",
                  color: "var(--color-ink-2)",
                }}
              >
                Collection cannot work for this domain until its DMARC record
                publishes a ruf= address
                {state.forensicAddress ? (
                  <>
                    {" "}
                    Add{" "}
                    <span className="num">ruf=mailto:{state.forensicAddress}</span> to the
                    record on {domain.name}, then run a scan so the change is read back.
                  </>
                ) : (
                  "."
                )}{" "}
                The API refuses to store a report for a domain with no ruf=
                address, and reports will not arrive from reporters either.
              </p>
            ) : null}

            {error ? (
              error.feature ? (
                <EntitlementNotice error={error} />
              ) : (
                <p role="alert" className="text-[13px]" style={{ color: "var(--color-block)" }}>
                  {error.message ?? "The collection setting could not be changed."}
                </p>
              )
            ) : null}

            {notice ? (
              <p role="status" className="text-[13px]" style={{ color: "var(--color-ink-2)" }}>
                {notice}
              </p>
            ) : null}

            <div>
              <ActionButton
                label={state.collectionEnabled ? "Stop collecting" : "Start collecting"}
                busy={busy}
                onClick={() => toggle(!state.collectionEnabled)}
                testId="forensics-collection-toggle"
                variant={state.collectionEnabled ? "ghost" : "primary"}
              />
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

// ─── named recipients ─────────────────────────────────────────────────────────

/**
 * Whether the recipient addresses, subject lines and envelope senders behind a
 * forensic report are kept, or only their pseudonyms.
 *
 * This is the more expensive licence (reports.forensicNamed) and the more
 * consequential switch. Turning it on starts storing personal data, so the
 * lawful basis is confirmed in the UI and sent as `confirmLegalBasis`; the API
 * refuses the call without it. Turning it off destroys that personal data
 * everywhere it was stored for this domain, irreversibly, so it goes through
 * ConfirmAction with the consequence naming what is lost, and the count the API
 * returns is shown rather than summarised.
 *
 * What survives a purge is stated before the button, not after: the pseudonymous
 * evidence (source IP, envelope and message pseudonyms, authentication results,
 * diagnostic codes) is untouched. That is the point of pseudonymizing, and a
 * reader deciding whether to purge deserves to know it.
 */
function IdentityPanel({
  organizationId,
  domain,
  state,
  retention,
  namedEntitled,
  planLabel,
}: {
  organizationId: string;
  domain: ForensicsDomainOption;
  state: ForensicDomainStateView;
  retention: ForensicRetentionSummary | null;
  namedEntitled: boolean;
  planLabel: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [basisConfirmed, setBasisConfirmed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<ApiErrorBody["error"] | null>(null);

  async function change(retainForensicPii: boolean) {
    setBusy(true);
    setNotice(null);
    setError(null);
    const res = await setForensicIdentityRetention(organizationId, domain.id, {
      retainForensicPii,
      confirmLegalBasis: retainForensicPii,
      confirmNamePurge: !retainForensicPii,
    });
    setBusy(false);

    if (!res.ok) {
      // The API's purge_confirmation_required carries a flag rather than only a
      // sentence, so a stale read (identities already purged by somebody else)
      // cannot turn this into a dead button: the message below is the API
      // explaining exactly what a purge costs.
      setError(res.error);
      return;
    }

    setNotice(
      retainForensicPii
        ? `Named recipients are now retained for ${domain.name} (${
            retention ? `deleted automatically after ${retention.piiRetentionDays} days` : "deleted when the retention window passes"
          }). From the next report onwards the recipient addresses, subject lines and envelope senders are stored in the clear, readable by anyone whose role holds forensic identify.`
        : `Named recipients are no longer retained for ${domain.name}. ${
            res.data.purgedIdentities === 0
              ? "No stored report held a recipient identity, so nothing was destroyed."
              : `The stored recipient addresses, subject lines and envelope senders were destroyed in ${res.data.purgedIdentities} report${res.data.purgedIdentities === 1 ? "" : "s"}, and that cannot be undone. The pseudonymous evidence in those reports is unchanged.`
          }`,
    );
    setBasisConfirmed(false);
    router.refresh();
  }

  return (
    <section
      className="lift rounded-[2px] border"
      style={{ background: "var(--color-surface)", borderColor: "var(--color-line)" }}
      data-testid="forensics-identity"
    >
      <header className="border-b px-5 py-3.5" style={{ borderColor: "var(--color-line)" }}>
        <h2 className="text-[16.5px] font-semibold tracking-[-0.012em]">
          Named recipients
        </h2>
        <p className="mt-1 text-[13px]" style={{ color: "var(--color-ink-2)" }}>
          Whether a forensic report for {domain.name} keeps the recipient
          addresses, subject lines and envelope senders behind it, or only
          pseudonyms that cannot be resolved back to a person.
        </p>
      </header>

      <div className="px-5 py-4">
        {!namedEntitled ? (
          <NamedNotEntitled planLabel={planLabel} />
        ) : state.status === "failed" ? (
          <ErrorState
            what="this domain's named-recipient setting"
            detail={`Nothing is known about whether recipient identities are retained for ${domain.name}, so this panel will not present a switch that might be showing the wrong state.`}
          />
        ) : (
          <div className="flex flex-col gap-3.5">
            <div className="flex flex-wrap items-baseline gap-x-5 gap-y-2">
              <span
                className="num text-[11.5px] font-semibold tracking-[0.12em] uppercase"
                style={{
                  color: state.identityRetentionEnabled
                    ? "var(--color-block)"
                    : "var(--color-pass)",
                }}
                data-testid="forensics-identity-state"
              >
                {state.identityRetentionEnabled
                  ? "recipient identities retained"
                  : "pseudonyms only"}
              </span>
              {state.identityRetentionEnabled && retention ? (
                <span className="num text-[12.5px]" style={{ color: "var(--color-ink-2)" }}>
                  personal data, deleted automatically after {retention.piiRetentionDays} days
                </span>
              ) : null}
            </div>

            {state.identityRetentionEnabled ? (
              <>
                <p className="text-[13px]" style={{ color: "var(--color-ink-2)" }}>
                  Turning this off is destructive and cannot be undone. It deletes
                  the stored recipient addresses, subject lines and envelope
                  senders for every forensic report of {domain.name} that holds
                  them. What survives: the source IP, the envelope and message
                  pseudonyms, the authentication results and the diagnostic codes.
                  That is pseudonymized evidence, and it stays usable.
                </p>
                <ConfirmAction
                  label="Stop retaining named recipients"
                  confirmLabel="Delete the stored identities"
                  consequence={`Deletes stored recipient addresses, subject lines and envelope senders for ${domain.name}. Cannot be undone.`}
                  onConfirm={() => change(false)}
                  busy={busy}
                  testId="forensics-identity-disable"
                />
              </>
            ) : (
              <>
                <p className="text-[13px]" style={{ color: "var(--color-ink-2)" }}>
                  Every forensic report for {domain.name} is stored with
                  pseudonymous recipients: the evidence of a failure is kept, and
                  the person it happened to is not identifiable from it. Reports
                  ingested from now on follow the same rule.
                </p>
                <label className="flex items-start gap-2.5 text-[13px]" style={{ color: "var(--color-ink-2)" }}>
                  <input
                    type="checkbox"
                    checked={basisConfirmed}
                    onChange={(e) => setBasisConfirmed(e.target.checked)}
                    data-testid="forensics-legal-basis"
                    style={{ marginTop: 3 }}
                  />
                  <span>
                    This workspace has a documented lawful basis for storing
                    recipient addresses and subject lines. The API records this
                    confirmation against the setting and refuses the change
                    without it.
                  </span>
                </label>
                <ConfirmAction
                  label="Retain named recipients"
                  confirmLabel="Start storing recipient identities"
                  consequence={
                    retention
                      ? `Stores recipient addresses, subject lines and envelope senders in the clear for ${retention.piiRetentionDays} days.`
                      : "Stores recipient addresses, subject lines and envelope senders in the clear."
                  }
                  onConfirm={() => change(true)}
                  busy={busy || !basisConfirmed}
                  testId="forensics-identity-enable"
                />
                {!basisConfirmed ? (
                  <p className="text-[12.5px]" style={{ color: "var(--color-ink-3)" }}>
                    The confirmation button stays disabled until the statement
                    above is ticked. Retaining named recipients is personal data,
                    and the API refuses the request without a stated basis.
                  </p>
                ) : null}
              </>
            )}

            {error ? (
              error.feature ? (
                <EntitlementNotice error={error} />
              ) : (
                <p
                  role="alert"
                  className="text-[13px]"
                  style={{ color: error.requiresNamePurgeConfirmation ? "var(--color-unverified)" : "var(--color-block)" }}
                  data-testid="forensics-identity-error"
                >
                  {error.message ?? "The named-recipient setting could not be changed."}
                </p>
              )
            ) : null}

            {notice ? (
              <p role="status" className="text-[13px]" style={{ color: "var(--color-ink-2)" }}>
                {notice}
              </p>
            ) : null}
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * The workspace does not carry reports.forensicNamed.
 *
 * Said in words rather than shown as a disabled control, because a greyed switch
 * invites somebody to believe the switch is the thing standing between them and
 * the feature. What is standing between them is the licence, and this is a
 * different and more expensive one than the forensic reporting they already have.
 */
function NamedNotEntitled({ planLabel }: { planLabel: string | null }) {
  return (
    <div
      role="status"
      data-testid="forensics-named-not-entitled"
      className="rounded-[2px] border px-4 py-3.5"
      style={{
        borderColor: "var(--color-unverified)",
        background: "var(--color-unverified-soft)",
      }}
    >
      <div
        className="num text-[11px] font-semibold tracking-[0.12em] uppercase"
        style={{ color: "var(--color-unverified)" }}
      >
        Not on this workspace's plan
      </div>
      <p className="mt-1.5 text-[15px]" style={{ color: "var(--color-ink-2)" }}>
        Named recipients are a separate, more expensive licence from forensic
        reporting
        {planLabel ? (
          <>
            , and <span className="num">{planLabel}</span> does not carry it
          </>
        ) : (
          " that this workspace's plan does not carry"
        )}
        . Forensic reports are still collected and stored here, with pseudonymous
        recipients, and the rest of this section works.
      </p>
      <p className="mt-1.5 text-[13px]" style={{ color: "var(--color-ink-3)" }}>
        The API enforces this itself: the route that changes named-recipient
        retention is the only forensic route gated on that entitlement, and it
        answers 402 rather than applying the change.
      </p>
      <Link
        href="/billing"
        className="mt-2.5 inline-block text-[14px] font-semibold underline"
        style={{ color: "var(--color-ink)" }}
      >
        See plan options
      </Link>
    </div>
  );
}

// ─── the stored reports ───────────────────────────────────────────────────────

function ReportList({
  organizationId,
  domain,
  reports,
}: {
  organizationId: string;
  domain: ForensicsDomainOption;
  reports: ForensicReportsView;
}) {
  const router = useRouter();
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ForensicReportRow | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [erasingId, setErasingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<ApiErrorBody["error"] | null>(null);

  async function open(forensicId: string) {
    if (openId === forensicId) {
      setOpenId(null);
      setDetail(null);
      setDetailError(null);
      return;
    }
    setOpenId(forensicId);
    setDetail(null);
    setDetailError(null);
    setDetailBusy(true);
    const res = await fetchForensicReport(organizationId, forensicId);
    setDetailBusy(false);
    if (!res.ok) {
      setDetailError(res.error.message ?? "That report could not be read.");
      return;
    }
    setDetail(res.data);
  }

  async function erase(forensicId: string, reportedDomain: string) {
    setErasingId(forensicId);
    setNotice(null);
    setError(null);
    const res = await deleteForensicReport(organizationId, forensicId);
    setErasingId(null);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setNotice(
      `Erased the forensic report for ${reportedDomain}. The row is deleted from the store and cannot be recovered. The audit trail records that this happened.`,
    );
    if (openId === forensicId) {
      setOpenId(null);
      setDetail(null);
    }
    router.refresh();
  }

  return (
    <section
      className="lift rounded-[2px] border"
      style={{ background: "var(--color-surface)", borderColor: "var(--color-line)" }}
      data-testid="forensics-reports"
    >
      <header
        className="flex flex-wrap items-baseline justify-between gap-3 border-b px-5 py-3.5"
        style={{ borderColor: "var(--color-line)" }}
      >
        <div>
          <h2 className="text-[16.5px] font-semibold tracking-[-0.012em]">
            Forensic reports
          </h2>
          <p className="num mt-1 text-[12.5px]" style={{ color: "var(--color-ink-3)" }}>
            {reports.status === "ok"
              ? `${reports.rows.length} shown${
                  reports.hasMore ? ", newest first, with more available" : ""
                }`
              : "the report list could not be read"}
          </p>
        </div>
        {reports.status === "ok" && reports.hasMore && reports.nextCursor ? (
          <Link
            href={forensicsHref({ domain: domain.id, cursor: reports.nextCursor })}
            className="text-[12.5px] underline"
            style={{ color: "var(--color-ink-2)" }}
            data-testid="forensics-older"
          >
            show older reports
          </Link>
        ) : null}
      </header>

      {reports.retention && reports.status === "ok" ? (
        <p
          className="border-b px-5 py-2.5 text-[12.5px]"
          style={{ borderColor: "var(--color-line)", color: "var(--color-ink-3)" }}
        >
          Forensic reports for {domain.name} are deleted {reports.retention.retentionDays}{" "}
          days after they arrive, and any named recipient data{" "}
          {reports.retention.piiRetentionDays} days after that, whichever comes
          first. Redaction version {reports.retention.redactionVersion}.
        </p>
      ) : null}

      <div className="px-5 py-4">
        {reports.status === "forbidden" ? (
          <RefusedNotice
            what="the forensic reports"
            message={reports.detail}
            explanation="Reading forensic evidence needs the forensic read permission, and a viewer role does not hold it. That is a role answer, not an empty domain."
          />
        ) : reports.status === "unlicensed" ? (
          <RefusedNotice
            what="forensic reporting"
            message={reports.detail}
            explanation="The forensic report routes are the part of this API gated on the forensic reporting entitlement, so a plan that does not carry it is answered with a refusal rather than an empty list."
          />
        ) : reports.status === "failed" ? (
          <ErrorState
            what={`the forensic reports for ${domain.name}`}
            detail={`A domain with no forensic reports and a report list this page could not read look identical in a table. Only the second is a failure, and nothing was deleted to produce it.`}
          />
        ) : reports.rows.length === 0 ? (
          <EmptyState
            title={`No forensic report has been collected for ${domain.name}`}
            description="Forensic reports arrive from the reporters a domain names in its ruf= tag. A report cannot be stored for a domain that publishes none, and none is stored for a domain whose collection is off. Check the panel above for which of the two applies here."
          />
        ) : (
          <ul>
            {reports.rows.map((row) => (
              <li key={row.id} className="border-b" style={{ borderColor: "rgba(255,255,255,0.055)" }}>
                <div className="flex flex-wrap items-center gap-x-5 gap-y-2 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="num text-[13px]" style={{ color: "var(--color-ink)" }}>
                      {row.sourceIp}
                      {row.sourcePort !== null ? `:${row.sourcePort}` : ""} ·{" "}
                      {row.reportedDomain}
                    </div>
                    <div className="num text-[12px]" style={{ color: "var(--color-ink-3)" }}>
                      {row.receivedLabel} · {row.recipientCount} recipient
                      {row.recipientCount === 1 ? "" : "s"}
                      {row.disposition ? ` · disposition ${row.disposition}` : ""}
                      {row.deliveryAction ? ` · ${row.deliveryAction}` : ""}
                    </div>
                  </div>
                  <IdentityBadge identities={row.identities} />
                  <span
                    className="num text-[11.5px]"
                    style={{
                      color:
                        row.dkimResult === "pass" && row.spfResult === "pass"
                          ? "var(--color-pass)"
                          : "var(--color-block)",
                    }}
                  >
                    spf {row.spfResult ?? "?"} · dkim {row.dkimResult ?? "?"}
                  </span>
                  <ActionButton
                    label={openId === row.id ? "Close" : "View detail"}
                    variant="ghost"
                    onClick={() => open(row.id)}
                    testId={`forensic-detail-${row.id}`}
                    style={{ padding: "6px 12px", fontSize: 12 }}
                  />
                  <ConfirmAction
                    label="erase this report"
                    confirmLabel="Erase it"
                    consequence="Deletes this report and any stored recipient identities. Cannot be undone."
                    onConfirm={() => erase(row.id, row.reportedDomain)}
                    busy={erasingId === row.id}
                    testId={`forensic-erase-${row.id}`}
                  />
                </div>

                {openId === row.id ? (
                  <div className="pb-4">
                    {detailBusy ? (
                      <LoadingState label="Loading that forensic report" />
                    ) : detailError ? (
                      <ErrorState
                        what="that forensic report"
                        detail={`The row is still listed above, so the report exists and is stored. This is a failure to read it, not a missing report.`}
                      />
                    ) : detail ? (
                      <ForensicDetail report={detail} />
                    ) : null}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {error ? (
          error.feature ? (
            <div className="mt-4">
              <EntitlementNotice error={error} />
            </div>
          ) : (
            <p role="alert" className="mt-4 text-[13px]" style={{ color: "var(--color-block)" }}>
              {error.message ?? "The report could not be erased."}
            </p>
          )
        ) : null}

        {notice ? (
          <p role="status" className="mt-4 text-[13px]" style={{ color: "var(--color-ink-2)" }}>
            {notice}
          </p>
        ) : null}
      </div>
    </section>
  );
}

/** Which of the three identity states a report is in. Never a bare boolean. */
function IdentityBadge({ identities }: { identities: ForensicReportListRow["identities"] }) {
  const map = {
    stored: { label: "identities stored", color: "var(--color-block)" },
    withheld: { label: "identities withheld from your role", color: "var(--color-unverified)" },
    pseudonymous: { label: "pseudonyms only", color: "var(--color-ink-3)" },
  } as const;
  const entry = map[identities];
  return (
    <span
      className="num text-[11.5px] tracking-[0.12em] uppercase"
      style={{ color: entry.color }}
    >
      {entry.label}
    </span>
  );
}

/** One report, read on demand, as evidence rather than as a summary. */
function ForensicDetail({ report }: { report: ForensicReportRow }) {
  const pseudonyms = report.recipientPseudonyms ?? [];
  const addresses = report.recipientAddresses ?? [];
  const identitiesVisible = addresses.length > 0 || Boolean(report.subjectLine) || Boolean(report.envelopeFrom);

  return (
    <div className="flex flex-col gap-4" data-testid="forensic-detail-body">
      <dl className="grid grid-cols-[minmax(0,11rem)_minmax(0,1fr)] gap-x-4 gap-y-1">
        <Detail k="Feedback type" v={report.feedbackType} />
        <Detail k="Source" v={`${report.sourceIp}${report.sourcePort !== null ? `:${report.sourcePort}` : ""}`} />
        <Detail k="Disposition" v={report.disposition ?? "not stated"} />
        <Detail k="Delivery action" v={report.deliveryAction ?? "not stated"} />
        <Detail k="Delivery status" v={report.deliveryStatus ?? "not stated"} />
        <Detail k="SPF" v={report.spfResult ?? "not stated"} />
        <Detail k="DKIM" v={report.dkimResult ?? "not stated"} />
        <Detail k="Reporting MTA" v={report.reportingMta ?? "not stated"} />
        <Detail k="DSN gateway" v={report.dsnGateway ?? "not stated"} />
        <Detail k="Remote MTA" v={report.remoteMta ?? "not stated"} />
        <Detail k="User agent" v={report.userAgent ?? "not stated"} />
        <Detail k="Recipients" v={`${report.recipientCount}`} />
        <Detail k="Received" v={instantLabel(report.receivedAt)} />
        <Detail k="Arrived at sender" v={instantLabel(report.arrivedAt)} />
        <Detail k="Original headers" v={report.hasOriginalHeaders ? "included in the report" : "not included"} />
        <Detail k="Original message" v={report.hasOriginalMessageIncluded ? "included in the report" : "not included"} />
        <Detail k="Redaction version" v={String(report.redactionVersion)} />
        <Detail k="Retention expires" v={instantLabel(report.retentionExpiresAt)} />
      </dl>

      <div>
        <div className="label">Recipient identities</div>
        {report.piiWithheld ? (
          <p className="mt-1.5 text-[13px]" style={{ color: "var(--color-unverified)" }}>
            Identities were retained for this report but are withheld from your
            role. Reading them needs the forensic identify permission. The
            pseudonyms below are complete evidence of the delivery without them.
          </p>
        ) : identitiesVisible ? (
          <dl className="mt-1.5 flex flex-col gap-1">
            {addresses.length > 0 ? (
              <Detail k="Recipients" v={addresses.join(", ")} />
            ) : null}
            {report.envelopeFrom ? <Detail k="Envelope sender" v={report.envelopeFrom} /> : null}
            {report.subjectLine ? <Detail k="Subject" v={report.subjectLine} /> : null}
          </dl>
        ) : (
          <p className="mt-1.5 text-[13px]" style={{ color: "var(--color-ink-2)" }}>
            No recipient identity was stored for this report. It was ingested
            with pseudonymous recipients, and only the pseudonyms below exist.
          </p>
        )}
        <p className="num mt-1.5 break-words text-[12px]" style={{ color: "var(--color-ink-3)" }}>
          {pseudonyms.length === 0
            ? "no recipient pseudonyms recorded"
            : `recipient pseudonyms: ${pseudonyms.join(", ")}`}
        </p>
      </div>

      <div>
        <div className="label">Stable identifiers</div>
        <dl className="mt-1.5 flex flex-col gap-1">
          <Detail k="Fingerprint" v={report.fingerprint} />
          {report.envelopeFromPseudonym ? (
            <Detail k="Envelope sender" v={report.envelopeFromPseudonym} />
          ) : null}
          {report.messageIdPseudonym ? (
            <Detail k="Message id" v={report.messageIdPseudonym} />
          ) : null}
          {report.subjectPseudonym ? (
            <Detail k="Subject" v={report.subjectPseudonym} />
          ) : null}
        </dl>
      </div>

      {report.authResults && report.authResults.length > 0 ? (
        <div>
          <div className="label">Authentication results</div>
          <ul className="mt-1.5 flex flex-col gap-0.5">
            {report.authResults.map((result, index) => (
              <li key={`${result.type}-${index}`} className="num text-[12.5px]" style={{ color: "var(--color-ink-2)" }}>
                {result.type} {result.result}
                {result.domain ? ` for ${result.domain}` : ""}
                {result.selector ? ` selector ${result.selector}` : ""}
                {result.scope ? ` (${result.scope})` : ""}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {report.diagnosticCodes && report.diagnosticCodes.length > 0 ? (
        <div>
          <div className="label">Diagnostic codes</div>
          <ul className="mt-1.5 flex flex-col gap-0.5">
            {report.diagnosticCodes.map((code, index) => (
              <li key={index} className="num break-words text-[12.5px]" style={{ color: "var(--color-ink-2)" }}>
                {code}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/** A 403 or a 402: a refusal with a reason, never an absence with a reason. */
function RefusedNotice({
  what,
  message,
  explanation,
}: {
  what: string;
  message: string | null;
  explanation: string;
}) {
  return (
    <div
      role="status"
      className="rounded-[2px] border px-4 py-4"
      style={{
        borderColor: "var(--color-unverified)",
        background: "var(--color-unverified-soft)",
      }}
      data-testid="forensics-refused"
    >
      <div
        className="num text-[11px] font-semibold tracking-[0.12em] uppercase"
        style={{ color: "var(--color-unverified)" }}
      >
        Refused
      </div>
      <p className="mt-1.5 text-[15px]" style={{ color: "var(--color-ink-2)" }}>
        {message ?? `The API refused to return ${what}.`}
      </p>
      <p className="mt-1.5 text-[13px]" style={{ color: "var(--color-ink-3)" }}>
        {explanation}
      </p>
    </div>
  );
}

// ─── destroying a domain's whole forensic history ──────────────────────────────

/**
 * The wide one. Every forensic report for one domain, identities included, gone
 * in one call. No grace period and no undo, so it is confirmed with the
 * consequence written out rather than behind a word like "delete".
 *
 * Offered only when the list actually loaded and has rows. A purge control shown
 * while the list is unknown would ask somebody to destroy evidence on the
 * strength of a read that failed, which is exactly the moment it should not be
 * one keystroke away.
 */
function DomainPurgePanel({
  organizationId,
  domain,
}: {
  organizationId: string;
  domain: ForensicsDomainOption;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function purge() {
    setBusy(true);
    setNotice(null);
    setError(null);
    const res = await purgeDomainForensics(organizationId, domain.id);
    setBusy(false);
    if (!res.ok) {
      setError(res.error.message ?? "The forensic reports could not be erased.");
      return;
    }
    setNotice(
      res.data.deleted === 0
        ? "Nothing was stored for this domain, so nothing was erased."
        : `Erased ${res.data.deleted} forensic report${res.data.deleted === 1 ? "" : "s"} for ${domain.name}, recipient identities included. This cannot be undone. The audit trail records that this happened.`,
    );
    router.refresh();
  }

  return (
    <section
      className="lift rounded-[2px] border"
      style={{ background: "var(--color-surface)", borderColor: "var(--color-block)" }}
      data-testid="forensics-domain-purge"
    >
      <header className="border-b px-5 py-3.5" style={{ borderColor: "var(--color-block)" }}>
        <h2 className="text-[16.5px] font-semibold tracking-[-0.012em]">
          Erase this domain's forensic history
        </h2>
        <p className="mt-1 text-[13px]" style={{ color: "var(--color-ink-2)" }}>
          Every forensic report held for {domain.name}, in one call. This
          mutates evidence: the rows are deleted, the recipient identities go
          with them, and there is no undo and no grace period. The only record
          that it happened is a line in the audit trail.
        </p>
      </header>
      <div className="px-5 py-4">
        <ConfirmAction
          label={`Erase every forensic report for ${domain.name}`}
          confirmLabel="Erase them all"
          consequence={`Deletes every forensic report for ${domain.name}, recipient identities included. Cannot be undone.`}
          onConfirm={purge}
          busy={busy}
          testId="forensics-purge-domain"
        />
        {notice ? (
          <p role="status" className="mt-3 text-[13px]" style={{ color: "var(--color-ink-2)" }}>
            {notice}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="mt-3 text-[13px]" style={{ color: "var(--color-block)" }}>
            {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}

// ─── storing a report by hand ─────────────────────────────────────────────────

/**
 * POST a raw forensic report email, for the domain whose ruf= tag points
 * somewhere we can read it.
 *
 * This ADDS evidence, so it deletes nothing and needs no confirmation. It exists
 * because the only other route in is a reporter sending a real message to a real
 * mailbox, and the API's own contract for this endpoint is a raw RFC822 body.
 *
 * A repeat delivery is not a failure: the API fingerprints the report and
 * answers 200 with `duplicate`, so the notice says which of the two happened
 * rather than claiming a new row either way.
 */
function IngestPanel({
  organizationId,
  domain,
  state,
}: {
  organizationId: string;
  domain: ForensicsDomainOption;
  state: ForensicDomainStateView;
}) {
  const router = useRouter();
  const [raw, setRaw] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<ApiErrorBody["error"] | null>(null);

  const verified = domain.status === "VERIFIED";
  const blocked: string | null =
    !verified
      ? `The API refuses to ingest for ${domain.name} until it is verified.`
      : !state.collectionEnabled
        ? `Collection is off for ${domain.name}, so the API refuses to ingest for it. Turn collection on above.`
        : !state.rufConfigured
          ? `${domain.name} publishes no ruf= address, so the API refuses to ingest for it: a forensic report for this domain is not one we could have been sent.`
          : null;

  async function submit() {
    if (raw.trim().length === 0 || blocked) return;
    setBusy(true);
    setNotice(null);
    setError(null);
    const res = await ingestForensicReport(organizationId, domain.id, raw);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setNotice(
      res.data.duplicate
        ? "This exact message was already stored. The API matched its fingerprint against a report it already held, so nothing was added."
        : `Stored the forensic report for ${res.data.forensic.reportedDomain}, received ${instantLabel(res.data.forensic.receivedAt)}. Pseudonymized evidence is kept${
            res.data.forensic.piiRetained
              ? ", and recipient identities are retained for this domain."
              : ", with pseudonymous recipients only."
          }`,
    );
    setRaw("");
    router.refresh();
  }

  return (
    <section
      className="lift rounded-[2px] border"
      style={{ background: "var(--color-surface)", borderColor: "var(--color-line)" }}
      data-testid="forensics-ingest"
    >
      <header className="border-b px-5 py-3.5" style={{ borderColor: "var(--color-line)" }}>
        <h2 className="text-[16.5px] font-semibold tracking-[-0.012em]">
          Store a forensic report by hand
        </h2>
        <p className="mt-1 text-[13px]" style={{ color: "var(--color-ink-2)" }}>
          Paste the raw message a reporter delivered, exactly as it arrived. The
          API parses it, checks it belongs to {domain.name}, and stores it
          redacted. This adds evidence; it removes nothing.
        </p>
      </header>
      <div className="px-5 py-4">
        {blocked ? (
          <p role="status" className="text-[13px]" style={{ color: "var(--color-unverified)" }}>
            {blocked}
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            <label className="flex flex-col gap-1.5">
              <span className="label">Raw report email</span>
              <textarea
                value={raw}
                onChange={(e) => setRaw(e.target.value)}
                rows={6}
                spellCheck={false}
                placeholder={"From: noreply-dmarc-support@google.com\nContent-Type: multipart/report; report-type=feedback-report; ..."}
                data-testid="forensics-raw-email"
                style={{ ...SELECT_STYLE, fontFamily: "var(--font-mono)", fontSize: 12 }}
              />
            </label>

            {error ? (
              error.feature ? (
                <EntitlementNotice error={error} />
              ) : (
                <p role="alert" className="text-[13px]" style={{ color: "var(--color-block)" }}>
                  {error.message ?? "The report could not be stored."}
                </p>
              )
            ) : null}

            {notice ? (
              <p role="status" className="text-[13px]" style={{ color: "var(--color-ink-2)" }}>
                {notice}
              </p>
            ) : null}

            <div>
              <ActionButton
                label="Store this report"
                busy={busy}
                disabled={raw.trim().length === 0}
                onClick={submit}
                testId="forensics-ingest-submit"
              />
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

// ─── shared bits ──────────────────────────────────────────────────────────────

function Detail({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt className="num text-[11.5px]" style={{ color: "var(--color-ink-3)" }}>
        {k}
      </dt>
      <dd className="num break-words text-[12.5px]" style={{ color: "var(--color-ink-2)" }}>
        {v}
      </dd>
    </>
  );
}

const SELECT_STYLE = {
  background: "var(--color-elevate)",
  border: "1px solid var(--color-line-strong)",
  borderRadius: 2,
  color: "var(--color-ink)",
  padding: "7px 10px",
  fontSize: 13.5,
} as const;