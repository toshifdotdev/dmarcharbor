/**
 * aggregate-report.ts — reads a DMARC aggregate report in the browser, for
 * the free report reader. Nothing here touches the network: the file a person
 * drops is opened, decompressed and parsed on their own machine.
 *
 * Accepts the XML itself, a gzip file (.xml.gz, what Microsoft and Yahoo send)
 * or a zip file (.zip, what Google sends), using the browser's own
 * DecompressionStream. Element names are matched by local name, so both the
 * RFC 7489 schema (no namespace) and the newer DMARC aggregate reporting
 * schema (urn:ietf:params:xml:ns:dmarc-2.0) read the same.
 *
 * The figures are the report's own: policy_evaluated's dkim and spf are the
 * receiver's DMARC-aligned results, so a row passes DMARC when either is pass.
 * Nothing is inferred beyond what the file says.
 */

export type Verdict = "pass" | "fail" | "none";

export interface ReportRow {
  sourceIp: string;
  count: number;
  disposition: string;
  /** The receiver's aligned results, from policy_evaluated. */
  dkimAligned: Verdict;
  spfAligned: Verdict;
  dmarc: "pass" | "fail";
  headerFrom: string;
  envelopeFrom: string | null;
  dkim: Array<{ domain: string; selector: string | null; result: string }>;
  spf: Array<{ domain: string; scope: string | null; result: string }>;
  reasons: string[];
}

export interface AggregateReport {
  orgName: string;
  email: string | null;
  reportId: string | null;
  begin: Date | null;
  end: Date | null;
  policy: {
    domain: string;
    p: string | null;
    sp: string | null;
    np: string | null;
    adkim: string | null;
    aspf: string | null;
    testing: string | null;
    pct: string | null;
  };
  rows: ReportRow[];
  totals: { messages: number; passed: number; failed: number; sources: number };
}

export class ReportReadError extends Error {}

/** The largest file the reader opens, decompressed: far above any real daily report. */
export const MAX_REPORT_BYTES = 50 * 1024 * 1024;

function children(parent: Element, name: string): Element[] {
  return Array.from(parent.children).filter((el) => el.localName === name);
}

function child(parent: Element | null | undefined, name: string): Element | null {
  return parent ? (children(parent, name)[0] ?? null) : null;
}

function text(parent: Element | null | undefined, name: string): string | null {
  const value = child(parent, name)?.textContent?.trim();
  return value ? value : null;
}

function verdict(value: string | null): Verdict {
  const v = (value ?? "").toLowerCase();
  return v === "pass" ? "pass" : v === "fail" ? "fail" : "none";
}

function epoch(value: string | null): Date | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const d = new Date(Number(value) * 1000);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function parseAggregateReport(xml: string): AggregateReport {
  // A DMARC report never declares a DOCTYPE or entities. Refusing them shuts
  // out entity-expansion files ("billion laughs") that would hang the tab, and
  // any external entity, before the parser sees them.
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) {
    throw new ReportReadError("This file declares a DOCTYPE or entities, which a DMARC report never does, so it was not read.");
  }
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.getElementsByTagName("parsererror").length > 0) {
    throw new ReportReadError("This is not well-formed XML, so it cannot be a DMARC report.");
  }
  const root = doc.documentElement;
  if (!root || root.localName !== "feedback") {
    throw new ReportReadError("This XML is not a DMARC aggregate report: its root element is not <feedback>.");
  }
  const meta = child(root, "report_metadata");
  const range = child(meta, "date_range");
  const published = child(root, "policy_published");
  const domain = text(published, "domain");
  if (!domain) throw new ReportReadError("The report names no domain in policy_published.");

  const rows: ReportRow[] = children(root, "record").map((record) => {
    const row = child(record, "row");
    const evaluated = child(row, "policy_evaluated");
    const identifiers = child(record, "identifiers");
    const auth = child(record, "auth_results");
    const dkimAligned = verdict(text(evaluated, "dkim"));
    const spfAligned = verdict(text(evaluated, "spf"));
    const count = Number(text(row, "count") ?? "0");
    return {
      sourceIp: text(row, "source_ip") ?? "unknown",
      count: Number.isFinite(count) && count > 0 ? Math.floor(count) : 0,
      disposition: (text(evaluated, "disposition") ?? "none").toLowerCase(),
      dkimAligned,
      spfAligned,
      dmarc: dkimAligned === "pass" || spfAligned === "pass" ? "pass" : "fail",
      headerFrom: text(identifiers, "header_from") ?? domain,
      envelopeFrom: text(identifiers, "envelope_from"),
      dkim: auth
        ? children(auth, "dkim").map((d) => ({ domain: text(d, "domain") ?? "", selector: text(d, "selector"), result: (text(d, "result") ?? "none").toLowerCase() }))
        : [],
      spf: auth
        ? children(auth, "spf").map((s) => ({ domain: text(s, "domain") ?? "", scope: text(s, "scope"), result: (text(s, "result") ?? "none").toLowerCase() }))
        : [],
      reasons: evaluated ? children(evaluated, "reason").map((r) => text(r, "type") ?? "").filter(Boolean) : [],
    };
  });

  rows.sort((a, b) => b.count - a.count);
  const messages = rows.reduce((n, r) => n + r.count, 0);
  const passed = rows.filter((r) => r.dmarc === "pass").reduce((n, r) => n + r.count, 0);
  return {
    orgName: text(meta, "org_name") ?? "Unknown receiver",
    email: text(meta, "email"),
    reportId: text(meta, "report_id"),
    begin: epoch(text(range, "begin")),
    end: epoch(text(range, "end")),
    policy: {
      domain,
      p: text(published, "p"),
      sp: text(published, "sp"),
      np: text(published, "np"),
      adkim: text(published, "adkim"),
      aspf: text(published, "aspf"),
      testing: text(published, "testing"),
      pct: text(published, "pct"),
    },
    rows,
    totals: { messages, passed, failed: messages - passed, sources: new Set(rows.map((r) => r.sourceIp)).size },
  };
}

async function inflate(data: Uint8Array, format: "gzip" | "deflate-raw"): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream(format));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_REPORT_BYTES) {
      await reader.cancel();
      throw new ReportReadError("The file opens to more than 50 MB, which is not a DMARC report.");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/** The first .xml entry of a zip file (Google's reports hold exactly one). */
async function unzipFirstXml(data: Uint8Array): Promise<Uint8Array> {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  // The end-of-central-directory record is in the last 64 KB plus 22 bytes.
  let eocd = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ReportReadError("This zip file is damaged: its directory is missing.");
  const entries = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  for (let e = 0; e < entries; e++) {
    if (view.getUint32(at, true) !== 0x02014b50) break;
    const method = view.getUint16(at + 10, true);
    const compressed = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(data.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extraLength + commentLength;
    if (!/\.xml$/i.test(name)) continue;
    const localName = view.getUint16(local + 26, true);
    const localExtra = view.getUint16(local + 28, true);
    const start = local + 30 + localName + localExtra;
    const body = data.subarray(start, start + compressed);
    if (method === 0) return body;
    if (method === 8) return inflate(body, "deflate-raw");
    throw new ReportReadError("This zip file uses a compression method the reader does not open.");
  }
  throw new ReportReadError("This zip file holds no .xml file.");
}

/** Opens what was dropped or chosen, by its first bytes rather than its name. */
export async function readReportFile(file: File): Promise<AggregateReport> {
  if (file.size > MAX_REPORT_BYTES) throw new ReportReadError("The file is larger than 50 MB, which is not a DMARC report.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  let xml: Uint8Array = bytes;
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) xml = await inflate(bytes, "gzip");
  else if (bytes[0] === 0x50 && bytes[1] === 0x4b) xml = await unzipFirstXml(bytes);
  return parseAggregateReport(new TextDecoder().decode(xml));
}
