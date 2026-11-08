/**
 * email-headers.ts — reads a message's headers, for the free header analyser.
 * Pure and offline: nothing here touches the network, and the page that uses
 * it never uploads what is pasted.
 *
 * What it reads:
 *   Received          the hops, oldest first, with the time each took;
 *   Authentication-Results
 *                     the receiver's own SPF, DKIM, DMARC and ARC verdicts
 *                     (the first such header, which the final receiver added);
 *   DKIM-Signature    the signing domains and selectors;
 *   From, Return-Path, Subject, Date, Message-ID.
 *
 * Alignment is worked out as DMARC does, against the organisational domain.
 * That needs the public suffix list, which this file does not ship; it
 * estimates the organisational domain from the last two labels, or three under
 * a common second-level suffix such as co.uk. The page says so.
 */

export type Verdict = "pass" | "fail" | "softfail" | "neutral" | "none" | "temperror" | "permerror" | "policy" | "unknown";

export interface Hop {
  from: string | null;
  by: string | null;
  with: string | null;
  at: Date | null;
  /** Seconds since the previous hop, when both have times. */
  delaySeconds: number | null;
}

export interface CheckResult {
  method: "spf" | "dkim" | "dmarc" | "arc";
  result: Verdict;
  /** smtp.mailfrom for SPF, header.d for DKIM, header.from for DMARC. */
  domain: string | null;
  selector: string | null;
}

export interface HeaderReading {
  from: string | null;
  fromDomain: string | null;
  returnPath: string | null;
  returnPathDomain: string | null;
  subject: string | null;
  date: string | null;
  messageId: string | null;
  authServer: string | null;
  checks: CheckResult[];
  signatures: Array<{ domain: string; selector: string | null }>;
  hops: Hop[];
  /** DMARC as the checks imply: an aligned SPF or DKIM pass. */
  computed: {
    spfAligned: boolean | null;
    dkimAligned: boolean | null;
    dmarc: "pass" | "fail" | "unknown";
  };
  headerCount: number;
}

export class HeaderReadError extends Error {}

const TWO_LEVEL = /^(co|com|net|org|gov|ac|edu|ltd|plc|nhs|sch|gen|me)\.[a-z]{2}$/;

/** An estimate of the organisational domain; see the note at the top. */
export function orgDomain(domain: string): string {
  const labels = domain.toLowerCase().replace(/\.$/, "").split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const lastTwo = labels.slice(-2).join(".");
  return TWO_LEVEL.test(lastTwo) ? labels.slice(-3).join(".") : lastTwo;
}

export function aligned(a: string | null, b: string | null): boolean | null {
  if (!a || !b) return null;
  return orgDomain(a) === orgDomain(b);
}

function domainOf(address: string | null): string | null {
  if (!address) return null;
  const inAngle = /<([^>]*)>/.exec(address)?.[1] ?? address;
  const at = inAngle.lastIndexOf("@");
  const d = (at >= 0 ? inAngle.slice(at + 1) : inAngle).trim().replace(/[>\s;,].*$/, "").toLowerCase();
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d) ? d : null;
}

/** Name: value pairs, folded lines joined, in the order they appear. */
export function splitHeaders(raw: string): Array<{ name: string; value: string }> {
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");
  const out: Array<{ name: string; value: string }> = [];
  for (const line of lines) {
    if (line.trim() === "") {
      if (out.length > 0) break; // the body starts
      continue;
    }
    if (/^[ \t]/.test(line) && out.length > 0) {
      out[out.length - 1]!.value += ` ${line.trim()}`;
      continue;
    }
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    out.push({ name: line.slice(0, colon).trim().toLowerCase(), value: line.slice(colon + 1).trim() });
  }
  return out;
}

function verdict(value: string): Verdict {
  const v = value.toLowerCase();
  return (["pass", "fail", "softfail", "neutral", "none", "temperror", "permerror", "policy"] as const).find((k) => k === v) ?? "unknown";
}

function prop(segment: string, name: string): string | null {
  const m = new RegExp(`\\b${name.replace(".", "\\.")}=([^\\s;]+)`, "i").exec(segment);
  return m ? m[1]!.replace(/^"|"$/g, "") : null;
}

function parseAuthResults(value: string): { server: string | null; checks: CheckResult[] } {
  const parts = value.split(";").map((p) => p.trim()).filter(Boolean);
  const server = parts[0] && !/=/.test(parts[0].split(/\s+/)[0] ?? "") ? (parts[0].split(/\s+/)[0] ?? null) : null;
  const checks: CheckResult[] = [];
  for (const part of parts) {
    const m = /^(spf|dkim|dmarc|arc)\s*=\s*([a-z]+)/i.exec(part);
    if (!m) continue;
    const method = m[1]!.toLowerCase() as CheckResult["method"];
    const domain =
      method === "spf"
        ? domainOf(prop(part, "smtp.mailfrom")) ?? prop(part, "smtp.helo")
        : method === "dkim"
          ? prop(part, "header.d") ?? domainOf(prop(part, "header.i"))
          : method === "dmarc"
            ? prop(part, "header.from")
            : null;
    checks.push({ method, result: verdict(m[2]!), domain: domain?.toLowerCase() ?? null, selector: method === "dkim" ? prop(part, "header.s") : null });
  }
  return { server, checks };
}

function parseReceived(value: string): Omit<Hop, "delaySeconds"> {
  const semi = value.lastIndexOf(";");
  const when = semi >= 0 ? new Date(value.slice(semi + 1).trim().replace(/\s*\([^)]*\)\s*$/, "")) : null;
  const body = semi >= 0 ? value.slice(0, semi) : value;
  const word = (key: string) => new RegExp(`\\b${key}\\s+([^\\s;()]+)`, "i").exec(body)?.[1] ?? null;
  return { from: word("from"), by: word("by"), with: word("with"), at: when && !Number.isNaN(when.getTime()) ? when : null };
}

/** Headers run to a few kilobytes; a whole message with attachments is far more. */
export const MAX_HEADER_CHARS = 512 * 1024;

export function readHeaders(raw: string): HeaderReading {
  if (raw.length > MAX_HEADER_CHARS) {
    throw new HeaderReadError("That is more than 512 KB, far more than any message's headers. Paste only the headers, not the whole message.");
  }
  const headers = splitHeaders(raw);
  if (headers.length === 0) throw new HeaderReadError("No headers were found. Paste the message source from the top, starting with a line such as Received: or From:.");
  const first = (name: string) => headers.find((h) => h.name === name)?.value ?? null;
  if (!headers.some((h) => ["received", "from", "authentication-results", "dkim-signature"].includes(h.name))) {
    throw new HeaderReadError("These lines are not email headers: there is no Received, From, Authentication-Results or DKIM-Signature line.");
  }

  const auth = first("authentication-results");
  const { server, checks } = auth ? parseAuthResults(auth) : { server: null, checks: [] };
  const signatures = headers
    .filter((h) => h.name === "dkim-signature")
    .map((h) => ({ domain: (prop(h.value, "d") ?? "").toLowerCase(), selector: prop(h.value, "s") }))
    .filter((s) => s.domain);

  const received = headers.filter((h) => h.name === "received").map((h) => parseReceived(h.value)).reverse();
  const hops: Hop[] = received.map((hop, i) => {
    const prev = received[i - 1];
    const delay = hop.at && prev?.at ? Math.round((hop.at.getTime() - prev.at.getTime()) / 1000) : null;
    return { ...hop, delaySeconds: delay };
  });

  const from = first("from");
  const fromDomain = domainOf(from);
  const returnPath = first("return-path");
  const spf = checks.find((c) => c.method === "spf");
  const spfDomain = spf?.domain ?? domainOf(returnPath);
  const dkimPasses = checks.filter((c) => c.method === "dkim" && c.result === "pass");
  const spfAligned = spf && spf.result === "pass" ? aligned(spfDomain, fromDomain) : spf ? false : null;
  const dkimAligned = dkimPasses.length ? dkimPasses.some((d) => aligned(d.domain, fromDomain) === true) : checks.some((c) => c.method === "dkim") ? false : null;
  const dmarc: HeaderReading["computed"]["dmarc"] =
    spfAligned === null && dkimAligned === null ? "unknown" : spfAligned || dkimAligned ? "pass" : "fail";

  return {
    from,
    fromDomain,
    returnPath,
    returnPathDomain: domainOf(returnPath),
    subject: first("subject"),
    date: first("date"),
    messageId: first("message-id"),
    authServer: server,
    checks,
    signatures,
    hops,
    computed: { spfAligned, dkimAligned, dmarc },
    headerCount: headers.length,
  };
}

/** Invented headers for the sample at rest: reserved names and documentation addresses. */
export const SAMPLE_HEADERS = `Delivered-To: frontdesk@haskerley-law.example
Received: by 2002:a05:6a10:9e0c:b0:61c:2e4f:1a2b with SMTP id c12csp1820340pxx;
        Tue, 27 Oct 2026 09:14:07 -0700 (PDT)
Authentication-Results: mx.sample-receiver.example;
       dkim=pass header.i=@pellowyn-dental.example header.s=selector1 header.b=Kp3mXq2a;
       spf=pass (sample-receiver.example: domain of reminders@pellowyn-dental.example designates 192.0.2.44 as permitted sender) smtp.mailfrom=reminders@pellowyn-dental.example;
       dmarc=pass (p=QUARANTINE sp=QUARANTINE dis=NONE) header.from=pellowyn-dental.example
Return-Path: <reminders@pellowyn-dental.example>
Received: from outbound.mail.sample-host.example (outbound.mail.sample-host.example. [192.0.2.44])
        by mx.sample-receiver.example with ESMTPS id 5b1f2c3d4e
        for <frontdesk@haskerley-law.example>
        (version=TLS1_3 cipher=TLS_AES_256_GCM_SHA384);
        Tue, 27 Oct 2026 09:14:06 -0700 (PDT)
Received: from app.pellowyn-dental.example (app.pellowyn-dental.example [198.51.100.10])
        by outbound.mail.sample-host.example with ESMTPSA id 88aa;
        Tue, 27 Oct 2026 16:14:02 +0000
DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed; d=pellowyn-dental.example; s=selector1;
        h=from:to:subject:date:message-id; bh=sampleBodyHash=; b=Kp3mXq2aSampleSignature
From: Pellowyn Dental <reminders@pellowyn-dental.example>
To: frontdesk@haskerley-law.example
Subject: Your appointment on Thursday
Date: Tue, 27 Oct 2026 16:14:01 +0000
Message-ID: <a1b2c3d4@app.pellowyn-dental.example>
`;
