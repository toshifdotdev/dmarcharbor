/**
 * report-sample.ts — the sample aggregate report the reader shows at rest,
 * labelled as sample on the page. Already parsed, so the server can render it
 * (the parser needs the browser's DOMParser). Invented: a reserved .example
 * domain, a receiver named as a sample, Microsoft and Mailgun addresses from
 * their published ranges, a forwarder and an unknown sender from the
 * documentation ranges (RFC 5737).
 */

import type { AggregateReport, ReportRow } from "@/lib/aggregate-report";

const DOMAIN = "pellowyn-dental.example";

function row(input: Omit<ReportRow, "dmarc" | "headerFrom" | "disposition" | "reasons"> & { reasons?: string[] }): ReportRow {
  return {
    ...input,
    headerFrom: DOMAIN,
    disposition: "none",
    reasons: input.reasons ?? [],
    dmarc: input.dkimAligned === "pass" || input.spfAligned === "pass" ? "pass" : "fail",
  };
}

const rows: ReportRow[] = [
  row({
    sourceIp: "40.107.22.81",
    count: 1184,
    dkimAligned: "pass",
    spfAligned: "pass",
    envelopeFrom: DOMAIN,
    dkim: [{ domain: DOMAIN, selector: "selector1", result: "pass" }],
    spf: [{ domain: DOMAIN, scope: "mfrom", result: "pass" }],
  }),
  row({
    sourceIp: "159.135.140.81",
    count: 412,
    dkimAligned: "pass",
    spfAligned: "fail",
    envelopeFrom: `mg.${DOMAIN}`,
    dkim: [{ domain: DOMAIN, selector: "mx", result: "pass" }],
    spf: [{ domain: `mg.${DOMAIN}`, scope: "mfrom", result: "pass" }],
  }),
  row({
    sourceIp: "40.107.23.14",
    count: 96,
    dkimAligned: "pass",
    spfAligned: "pass",
    envelopeFrom: DOMAIN,
    dkim: [{ domain: DOMAIN, selector: "selector2", result: "pass" }],
    spf: [{ domain: DOMAIN, scope: "mfrom", result: "pass" }],
  }),
  row({
    sourceIp: "203.0.113.45",
    count: 58,
    dkimAligned: "fail",
    spfAligned: "fail",
    envelopeFrom: DOMAIN,
    dkim: [],
    spf: [{ domain: DOMAIN, scope: "mfrom", result: "fail" }],
  }),
  row({
    sourceIp: "198.51.100.23",
    count: 37,
    dkimAligned: "fail",
    spfAligned: "fail",
    envelopeFrom: "lists.sample-forwarder.example",
    dkim: [{ domain: DOMAIN, selector: "selector1", result: "fail" }],
    spf: [{ domain: "lists.sample-forwarder.example", scope: "mfrom", result: "pass" }],
    reasons: ["forwarded"],
  }),
];

const messages = rows.reduce((n, r) => n + r.count, 0);
const passed = rows.filter((r) => r.dmarc === "pass").reduce((n, r) => n + r.count, 0);

export const SAMPLE_REPORT: AggregateReport = {
  orgName: "sample-receiver.example",
  email: "noreply-dmarc@sample-receiver.example",
  reportId: "17306784000000000001",
  begin: new Date(Date.UTC(2026, 9, 31, 0, 0, 0)),
  end: new Date(Date.UTC(2026, 9, 31, 23, 59, 59)),
  policy: { domain: DOMAIN, p: "none", sp: "none", np: null, adkim: "r", aspf: "r", testing: null, pct: null },
  rows,
  totals: { messages, passed, failed: messages - passed, sources: rows.length },
};
