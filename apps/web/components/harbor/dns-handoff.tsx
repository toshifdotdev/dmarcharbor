"use client";

/**
 * dns-handoff.tsx — the records a domain needs, laid out to be published by
 * whoever holds the DNS.
 *
 * At an agency that is often not the person reading this screen: it is the
 * client's IT contact, their registrar login, or a colleague. So the records
 * are numbered stops on one line (publish 1, then 2), each with its own copy
 * controls, and under them the handoff for someone else's DNS:
 *
 *   Email these records  opens a message already written: which records,
 *                        where, and that waiting a while for DNS is normal.
 *   Zone file lines      the records as BIND lines, for DNS providers that
 *                        take a zone import or whoever edits zone files.
 *
 * Every host and value shown here is the API's own string (the ownership record
 * from the create or verify response, the DMARC record from the onboarding
 * state). This component formats them; it never assembles one. It also sits
 * inside the first-domain, hosted DMARC, switch and switch-kit screens, so it
 * stays plain: no frame of its own, white ground, hairlines.
 */

import { useState } from "react";
import { clsx } from "clsx";
import { DnsRecord, CopyButton } from "@/components/ui/copy";
import { buttonClass } from "@/components/ui/button";
import type { DnsPublishRecord } from "@/lib/types";
import { DnsPublishButton, type DnsPublishContext } from "./dns-publish";

export type RecordTone = "ok" | "warn" | "fail" | "todo";

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
  /** Where the record stands, when the caller knows it from the API. */
  status?: { word: string; tone: RecordTone };
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

/**
 * A record's state as a word with its shape, never colour alone: a filled
 * square when it is live, a ring while DNS has not caught up, a diamond when
 * it has gone, a hollow station when it is still to publish.
 */
export function RecordState({ word, tone }: { word: string; tone: RecordTone }) {
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1.5 whitespace-nowrap text-meta font-semibold",
        tone === "ok" ? "text-ok" : tone === "warn" ? "text-warn" : tone === "fail" ? "text-fail" : "text-fg-2",
      )}
    >
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden className="shrink-0">
        {tone === "ok" ? <rect x="0.5" y="0.5" width="9" height="9" fill="var(--color-ok)" /> : null}
        {tone === "warn" ? <circle cx="5" cy="5" r="3.9" fill="none" stroke="var(--color-warn-mark)" strokeWidth="2" /> : null}
        {tone === "fail" ? <path d="M5 0 10 5 5 10 0 5Z" fill="var(--color-fail)" /> : null}
        {tone === "todo" ? <circle cx="5" cy="5" r="3.6" fill="#fff" stroke="var(--color-fg-4)" strokeWidth="2" /> : null}
      </svg>
      {word}
    </span>
  );
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
  const several = records.length > 1;

  return (
    <div className="flex flex-col gap-6">
      <ol className="flex flex-col">
        {records.map((r, i) => (
          <li key={r.host} className="relative grid grid-cols-[24px_minmax(0,1fr)] gap-x-3.5 pb-8 last:pb-0">
            {/* The records are stops on one line: the line runs to the next one. */}
            {i < records.length - 1 ? (
              <span aria-hidden className="absolute bottom-0 left-[10.5px] top-6 w-[3px] rounded-full bg-rule" />
            ) : null}
            <span
              aria-hidden
              className="tnum relative grid size-6 place-items-center rounded-full border-[2.5px] border-fg bg-paper text-meta font-bold text-fg"
            >
              {i + 1}
            </span>
            <div className="min-w-0">
              <div className="mb-2.5 flex min-h-6 flex-wrap items-center justify-between gap-x-4 gap-y-1">
                <p className="text-ui">
                  <span className="font-bold text-fg">{r.purpose}</span>{" "}
                  <span className="text-fg-3">{r.type ?? "TXT"} record</span>
                </p>
                {r.status ? <RecordState word={r.status.word} tone={r.status.tone} /> : null}
              </div>
              <DnsRecord type={r.type ?? "TXT"} host={r.host} zone={domain} value={r.value} note={r.note} testId={r.testId} />
              {publish && r.publish ? (
                <div className="mt-2.5">
                  <DnsPublishButton context={publish} record={r.publish} purpose={r.purpose} />
                </div>
              ) : null}
            </div>
          </li>
        ))}
      </ol>

      <div className="flex flex-col gap-3 border-t border-rule pt-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2.5">
          <p className="mr-auto min-w-0 text-ui">
            <span className="font-bold text-fg">Not your DNS?</span>{" "}
            <span className="text-fg-3">
              Send {several ? "these records" : "this record"} to whoever manages DNS for {domain}.
            </span>
          </p>
          <a href={mailto} className={buttonClass("secondary", "sm")}>
            Email {several ? "these records" : "this record"}
          </a>
          <button
            type="button"
            className={buttonClass("ghost", "sm")}
            aria-expanded={showZone}
            onClick={() => setShowZone((v) => !v)}
          >
            {showZone ? "Hide zone file lines" : "Zone file lines"}
          </button>
        </div>
        {showZone ? (
          <div data-copy-scope className="flex items-start gap-2 rounded-ctl border border-rule bg-paper-3 py-2 pl-3 pr-2">
            <pre data-copy-value className="data min-w-0 flex-1 overflow-x-auto whitespace-pre py-0.5 text-meta text-fg">
              {zone}
            </pre>
            <CopyButton value={zone} label="Copy zone file lines" />
          </div>
        ) : null}
      </div>
    </div>
  );
}
