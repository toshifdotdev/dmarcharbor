"use client";

/**
 * dns-handoff.tsx — the records a domain needs, laid out to be published by
 * whoever holds the DNS.
 *
 * At an agency that is often not the person reading this screen: it is the
 * client's IT contact, their registrar login, or a colleague. So besides each
 * record with its own copy controls, there are two handoffs:
 *
 *   Email them      opens a message already written: which records, where,
 *                   and that waiting a while for DNS is normal.
 *   Zone file lines both records as BIND lines, for DNS providers that take a
 *                   zone import or for whoever edits zone files by hand.
 *
 * Every host and value shown here is the API's own string (the ownership record
 * from the create or verify response, the DMARC record from the onboarding
 * state). This component formats them; it never assembles one.
 */

import { useState } from "react";
import { DnsRecord, CopyButton } from "@/components/ui/copy";
import type { DnsPublishRecord } from "@/lib/types";
import { DnsPublishButton, type DnsPublishContext } from "./dns-publish";

export interface PublishRecord {
  /** What the record is for, in plain words. */
  purpose: string;
  host: string;
  /** TXT unless a caller needs a CNAME (the hosted DMARC delegation). */
  type?: "TXT" | "CNAME";
  value: string;
  note?: React.ReactNode;
  testId?: string;
  /** Names a server-generated record that Cloudflare may publish. */
  publish?: DnsPublishRecord;
}

function quoteTxt(value: string): string {
  // TXT strings longer than 255 characters must be split into quoted chunks.
  const chunks = value.match(/.{1,255}/g) ?? [value];
  return chunks.map((c) => `"${c.replace(/"/g, '\\"')}"`).join(" ");
}

export function zoneLines(records: PublishRecord[]): string {
  return records
    .map((record) => {
      const type = record.type ?? "TXT";
      return type === "CNAME"
        ? `${record.host}. IN CNAME ${record.value}`
        : `${record.host}. IN TXT ${quoteTxt(record.value)}`;
    })
    .join("\n");
}

export function DnsHandoff({
  domain,
  records,
  publish,
}: {
  domain: string;
  records: PublishRecord[];
  publish?: DnsPublishContext;
}) {
  const [showZone, setShowZone] = useState(false);
  const zone = zoneLines(records);
  const types = [...new Set(records.map((record) => record.type ?? "TXT"))];
  const hasTxt = types.includes("TXT");
  const body = [
    `Hello,`,
    ``,
    `Please publish ${records.length === 1 ? "this DNS record" : `these ${records.length} DNS records`} for ${domain}. ${
      records.length === 1 ? "It is" : "They are"
    } ${types.join(" and ")} ${records.length === 1 ? "record" : "records"} and ${records.length === 1 ? "does" : "do"} not change how mail is delivered.`,
    ``,
    ...records.flatMap((r, i) => [`${i + 1}. ${r.purpose}`, `   Type:  ${r.type ?? "TXT"}`, `   Host:  ${r.host}`, `   Value: ${r.value}`, ``]),
    hasTxt
      ? `Some DNS panels want only the part of the host before ${domain}. Copy values exactly, including every semicolon.`
      : `Some DNS panels want only the part of the host before ${domain}. Copy the target exactly.`,
    `It can take a few hours for a new record to be visible everywhere. That is normal.`,
    ``,
    `Thank you.`,
  ].join("\n");
  const mailto = `mailto:?subject=${encodeURIComponent(`DNS records to publish for ${domain}`)}&body=${encodeURIComponent(body)}`;

  return (
    <div className="flex flex-col gap-5">
      <ol className="hb-stagger flex flex-col gap-5">
        {records.map((r, i) => (
          <li key={r.host} style={{ "--i": i } as React.CSSProperties}>
            <p className="mb-2 flex items-baseline gap-2 text-ui">
              <span className="tnum grid size-5 place-items-center rounded-full border border-fg text-meta font-bold text-fg">{i + 1}</span>
              <span className="font-semibold text-fg">{r.purpose}</span>
            </p>
            <DnsRecord type={r.type ?? "TXT"} host={r.host} zone={domain} value={r.value} note={r.note} testId={r.testId} />
            {publish && r.publish ? (
              <div className="mt-2">
                <DnsPublishButton context={publish} record={r.publish} purpose={r.purpose} />
              </div>
            ) : null}
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-rule pt-3 text-ui">
        <span className="legend">Hand it over</span>
        <a href={mailto} className="link font-semibold">
          Email these records
        </a>
        <button type="button" className="link font-semibold" aria-expanded={showZone} onClick={() => setShowZone((v) => !v)}>
          {showZone ? "Hide zone file lines" : "Zone file lines"}
        </button>
      </div>
      {showZone ? (
        <div data-copy-scope className="flex items-start gap-2 rounded-ctl border border-rule bg-paper-3 p-2.5 [animation:hb-rise_160ms_ease-out]">
          <pre data-copy-value className="data min-w-0 flex-1 overflow-x-auto whitespace-pre text-meta text-fg">
            {zone}
          </pre>
          <CopyButton value={zone} label="Copy zone file lines" />
        </div>
      ) : null}
    </div>
  );
}
