"use client";

/**
 * domain-records.tsx — the records a domain needs, and the check that proves
 * the first one is live.
 *
 * Two records, both the API's own strings:
 *   ownership  from the onboarding state, shown on load so it can be
 *              published before anyone presses Check. It used to appear only
 *              after a check, and a check before the record existed left a
 *              resolver caching the miss. The lookup itself still runs only
 *              when the operator presses it.
 *   DMARC      onboarding.suggestedRecord, verbatim, with the API's notes.
 *
 * Each record says where it stands, from the API only: the ownership record
 * from the check that issued it, the DMARC record from the dmarc_published
 * step. Once ownership is verified the ownership record is no longer
 * something to do, so it is not listed again unless a check has just
 * returned it.
 */

import { useState } from "react";
import Link from "next/link";
import type { DmarcRecordDraft, DnsConnectionRow, OnboardingState, TlsRecordView } from "@/lib/types";
import { DnsHandoff, RecordState, type PublishRecord } from "./dns-handoff";
import { DnsRecord } from "@/components/ui/copy";
import type { DnsPublishContext } from "./dns-publish";
import { OwnershipCheck, type Verification } from "./ownership-check";

type StepStatus = OnboardingState["steps"][number]["status"];

export function DomainRecords({
  organizationId,
  domainId,
  domainName,
  slug,
  verified,
  dmarc,
  dmarcStep = null,
  tlsRpt,
  publishedPolicy,
  canPublish,
  connections,
  brand = "DMARC Harbor",
  ownership = null,
}: {
  organizationId: string;
  domainId: string;
  domainName: string;
  slug: string;
  verified: boolean;
  dmarc: DmarcRecordDraft | null;
  /** The API's dmarc_published step status, when the steps loaded. */
  dmarcStep?: StepStatus | null;
  /** The TLS-RPT record to publish, when the API could build one. */
  tlsRpt?: TlsRecordView | null;
  /** The policy DNS already carries, from the onboarding state. */
  publishedPolicy: string | null;
  canPublish: boolean;
  connections: DnsConnectionRow[];
  /** The product name on this host (the agency's on a verified custom domain). */
  brand?: string;
  /** The ownership record from the onboarding state, while the domain is not verified. */
  ownership?: { host: string; value: string } | null;
}) {
  const [check, setCheck] = useState<Verification | null>(null);
  const publishContext: DnsPublishContext = {
    organizationId,
    domainId,
    connections,
    canPublish,
  };

  const records: PublishRecord[] = [];
  // The check's own record once one has run, else the one the page loaded with.
  const ownershipRecord = check ? (check.status !== "VERIFIED" ? check : null) : !verified ? ownership : null;
  if (ownershipRecord) {
    records.push({
      purpose: "Prove you manage this domain",
      host: ownershipRecord.host,
      value: ownershipRecord.value,
      note: "Only used to confirm ownership. It changes nothing about mail.",
      testId: "ownership-record",
      publish: { kind: "verification" },
      status: !check
        ? { word: "To publish", tone: "todo" }
        : check.status === "FAILED"
          ? { word: "Gone from DNS", tone: "fail" }
          : { word: "Not in DNS yet", tone: "warn" },
    });
  }
  // Replacing an enforcing record with a watching one would relax the domain:
  // say so rather than let "replace it" undo someone's enforcement.
  const STRENGTH: Record<string, number> = { none: 0, quarantine: 1, reject: 2 };
  const published = publishedPolicy?.toLowerCase() ?? null;
  const relaxes =
    dmarc !== null && published !== null && (STRENGTH[published] ?? -1) > (STRENGTH[dmarc.policy] ?? 0);

  if (dmarc) {
    records.push({
      purpose: dmarc.policy === "none" ? "Start receiving DMARC reports" : `Move the DMARC policy to p=${dmarc.policy}`,
      host: dmarc.host,
      value: dmarc.value,
      note: relaxes ? (
        <span className="font-semibold text-warn">
          This domain already publishes p={published}. Replacing its record with this one would relax it to p=
          {dmarc.policy}. To keep enforcement, keep the current policy and add only the rua= and ruf= addresses from
          this value.
        </span>
      ) : dmarc.policy === "none"
          ? "p=none only watches: no mail is blocked or quarantined. If a DMARC record already exists at this host, replace it: a domain can have only one."
          : dmarc.testing
            ? `Testing mode: receivers are asked to treat mail that fails one step softer than p=${dmarc.policy} while you watch the reports. Replace the record already at this host: a domain can have only one.`
            : `Receivers are asked to ${dmarc.policy === "reject" ? "reject" : "quarantine"} mail that fails. Replace the record already at this host: a domain can have only one.`,
      testId: "suggested-record",
      publish: { kind: "dmarc_suggested" },
      // The step says whether a DMARC record is live, not whether it is this
      // value, so the word names the policy DNS carries.
      status:
        dmarcStep === "done"
          ? { word: published ? `A record is live, p=${published}` : "A record is live", tone: "ok" }
          : dmarcStep
            ? { word: "To publish", tone: "todo" }
            : undefined,
    });
  }

  const ownershipStatus = check?.status ?? (verified ? "VERIFIED" : null);
  const ownershipDone = ownershipStatus === "VERIFIED";

  return (
    <div className="flex flex-col gap-10">
      <section aria-labelledby={`${domainId}-own`} className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h3 id={`${domainId}-own`} className="text-ui">
            <span className="font-bold text-fg">Ownership</span>{" "}
            <span className="text-fg-3">a TXT record that proves the domain is yours to monitor</span>
          </h3>
          {ownershipDone ? (
            <RecordState word="Verified" tone="ok" />
          ) : ownershipStatus === "FAILED" ? (
            <RecordState word="Record gone" tone="fail" />
          ) : ownershipStatus === "PENDING" ? (
            <RecordState word="Waiting on DNS" tone="warn" />
          ) : (
            <RecordState word="Not verified yet" tone="todo" />
          )}
        </div>
        <p className="max-w-[72ch] text-ui text-fg-2">
          {ownershipDone ? (
            <>Ownership is verified. The check reads DNS again whenever you need to confirm the record is still there.</>
          ) : check ? (
            <>
              Publish the ownership record below, then check again.{" "}
              <span className="font-semibold text-fg">Nothing found yet is normal</span>: DNS takes minutes to hours.
            </>
          ) : (
            <>
              Publish the ownership record below at the domain&rsquo;s DNS host, then check. A check before it is
              published <span className="font-semibold text-fg">finds nothing, which is the expected answer</span>.
            </>
          )}
        </p>
        <OwnershipCheck
          organizationId={organizationId}
          domainId={domainId}
          verified={verified}
          onResult={setCheck}
          showStoredStatus={false}
        />
      </section>

      {records.length > 0 ? (
        // Keyed by what is listed, so a newly issued ownership record replaces
        // the list rather than reusing the previous numbering's state.
        <DnsHandoff key={records.map((r) => r.host).join("|")} domain={domainName} records={records} publish={publishContext} />
      ) : (
        <p className="border-y border-rule py-3 text-ui text-fg-3">
          The DMARC record could not be generated just now. Reload the page to try again.
        </p>
      )}

      {dmarc ? (
        <div className="flex flex-col gap-5">
          <p className="max-w-[76ch] text-ui text-fg-2">
            Prefer not to edit DNS for every policy change?{" "}
            <Link href={`/domains/${encodeURIComponent(slug)}?tab=setup`} className="link font-semibold">
              Host this record with {brand}
            </Link>{" "}
            from the domain&apos;s Reporting and setup tab.
          </p>

          {dmarc.notes.length > 0 ? (
            <div>
              <p className="pb-2 text-ui font-bold text-fg">About this DMARC record</p>
              <ul className="flex max-w-[80ch] flex-col gap-1.5 text-ui text-fg-2">
                {dmarc.notes.map((n) => (
                  <li key={n} className="grid grid-cols-[14px_minmax(0,1fr)] gap-1.5">
                    <span aria-hidden className="mt-[8px] block h-[3px] w-2 rounded-full bg-rule-2" />
                    <span>{n}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}

      {tlsRpt ? (
        <section aria-labelledby={`${domainId}-tls`} className="flex flex-col gap-3 border-t border-rule pt-6">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h3 id={`${domainId}-tls`} className="text-ui">
              <span className="font-bold text-fg">TLS reports</span>{" "}
              <span className="text-fg-3">optional, never blocks the steps</span>
            </h3>
            {tlsRpt.status === "ours" ? <RecordState word="In place" tone="ok" /> : <RecordState word="Optional" tone="todo" />}
          </div>
          <p className="max-w-[72ch] text-ui text-fg-2">
            {tlsRpt.status === "ours"
              ? "Your TLS-RPT record is already in place, so senders can report failed TLS deliveries."
              : "Publish this record so senders can tell you why TLS deliveries failed. It is optional and never blocks the steps above."}
          </p>
          {tlsRpt.status !== "ours" ? (
            <DnsRecord type="TXT" host={tlsRpt.host} zone={domainName} value={tlsRpt.suggested} testId="onboarding-tls-record" />
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
