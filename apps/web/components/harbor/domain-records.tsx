"use client";

/**
 * domain-records.tsx — the records a domain needs, and the check that proves
 * the first one is live.
 *
 * Two records, both the API's own strings:
 *   ownership  issued by POST /verify, which also runs the DNS lookup. The
 *              lookup changes the domain's status and can notify people, so
 *              the record appears when the operator presses the check, never
 *              on page load. Before publishing, "nothing found" is the
 *              expected answer and is worded that way.
 *   DMARC      onboarding.suggestedRecord, verbatim, with the API's notes.
 *
 * Once ownership is verified the ownership record is no longer something to
 * do, so it is not listed again unless a check has just returned it.
 */

import { useState } from "react";
import Link from "next/link";
import type { DmarcRecordDraft, DnsConnectionRow } from "@/lib/types";
import { DnsHandoff, type PublishRecord } from "./dns-handoff";
import type { DnsPublishContext } from "./dns-publish";
import { OwnershipCheck, type Verification } from "./ownership-check";

export function DomainRecords({
  organizationId,
  domainId,
  domainName,
  slug,
  verified,
  dmarc,
  publishedPolicy,
  canPublish,
  connections,
}: {
  organizationId: string;
  domainId: string;
  domainName: string;
  slug: string;
  verified: boolean;
  dmarc: DmarcRecordDraft | null;
  /** The policy DNS already carries, from the onboarding state. */
  publishedPolicy: string | null;
  canPublish: boolean;
  connections: DnsConnectionRow[];
}) {
  const [check, setCheck] = useState<Verification | null>(null);
  const publishContext: DnsPublishContext = {
    organizationId,
    domainId,
    connections,
    canPublish,
  };

  const records: PublishRecord[] = [];
  if (check && check.status !== "VERIFIED") {
    records.push({
      purpose: "Prove you manage this domain",
      host: check.host,
      value: check.value,
      note: "Only used to confirm ownership. It changes nothing about mail.",
      testId: "ownership-record",
      publish: { kind: "verification" },
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
    });
  }

  const ownershipDone = (check?.status ?? (verified ? "VERIFIED" : null)) === "VERIFIED";

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <p className="text-ui text-fg-2">
          {ownershipDone ? (
            <>Ownership is verified. The check reads DNS again whenever you need to confirm the record is still there.</>
          ) : check ? (
            <>
              Publish the ownership record below, then check again.{" "}
              <span className="font-semibold text-fg">Nothing found yet is normal</span>: DNS takes minutes to hours.
            </>
          ) : (
            <>
              The ownership record comes with the check: press it to see the record to publish. Before you publish,{" "}
              <span className="font-semibold text-fg">a lookup that finds nothing is the expected answer</span>.
            </>
          )}
        </p>
        <OwnershipCheck organizationId={organizationId} domainId={domainId} verified={verified} onResult={setCheck} />
      </div>

      {records.length > 0 ? (
        // Keyed by what is listed, so a newly issued ownership record arrives
        // with the same stagger as the first render rather than popping in.
        <DnsHandoff key={records.map((r) => r.host).join("|")} domain={domainName} records={records} publish={publishContext} />
      ) : (
        <p className="border-y border-rule py-3 text-ui text-fg-3">
          The DMARC record could not be generated just now. Reload the page to try again.
        </p>
      )}

      {dmarc ? (
        <p className="max-w-[76ch] text-meta text-fg-2">
          Prefer not to edit DNS for every policy change?{" "}
          <Link href={`/domains/${encodeURIComponent(slug)}?tab=setup`} className="link font-semibold">
            Host this record with DMARC Harbor
          </Link>{" "}
          from the domain&apos;s Reporting and setup tab.
        </p>
      ) : null}

      {dmarc && dmarc.notes.length > 0 ? (
        <div>
          <p className="legend pb-1.5">About this DMARC record</p>
          <ul className="flex flex-col gap-1.5 text-ui text-fg-2">
            {dmarc.notes.map((n) => (
              <li key={n} className="grid grid-cols-[12px_minmax(0,1fr)] gap-1.5">
                <span aria-hidden className="mt-[8px] block h-px w-2 bg-fg-4" />
                <span>{n}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
