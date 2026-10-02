/**
 * seed.mjs — Phase 1 verification data. Dev script, not shipped code: it proves
 * the portfolio against real API responses with all four postures present.
 *
 * Run: DATABASE_URL=... node scripts/seed.mjs   (API on :4000)
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const API = process.env.API_BASE ?? "http://localhost:4000";

const WORKSPACE = { name: "Northgate Digital", slug: "northgate-digital" };
const ACCOUNT = {
  name: "Sam Morgan",
  email: "sam@northgate.test",
  password: "harbor-test-2026",
};

function log(step, detail) {
  console.log(`[seed] ${step}${detail ? " — " + detail : ""}`);
}

async function api(path, opts = {}, cookie) {
  const headers = {
    "content-type": "application/json",
    // better-auth rejects requests with no Origin (MISSING_OR_NULL_ORIGIN).
    // Browsers always send one; so must we.
    origin: "http://localhost:3100",
    ...(opts.headers ?? {}),
  };
  if (cookie) headers.cookie = cookie;
  const res = await fetch(`${API}${path}`, { ...opts, headers, redirect: "manual" });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body, headers: res.headers };
}

function cookieFrom(headers) {
  const raw = headers.getSetCookie?.() ?? [];
  const session = raw.find((c) => c.startsWith("better-auth.session_token="));
  return session ? session.split(";")[0] : null;
}

// ─── 1. account ───────────────────────────────────────────────────────────────

const signUp = await api("/api/auth/sign-up/email", {
  method: "POST",
  body: JSON.stringify(ACCOUNT),
});
log("sign-up", String(signUp.status));

// A sign-in attempt re-queues the verification email (sendOnSignIn) even when
// it cannot complete, which makes this script idempotent across runs.
await api("/api/auth/sign-in/email", {
  method: "POST",
  body: JSON.stringify({ email: ACCOUNT.email, password: ACCOUNT.password }),
});
await new Promise((r) => setTimeout(r, 600));

/**
 * Find the verification link for this account.
 *
 * Primary source is the API log written to a plain file (no terminal escape
 * sequences). The fallback scans terminal-session logs: those interleave CSI
 * and OSC escape sequences and wrap lines mid-URL, so they are cleaned and the
 * token is associated to its recipient by log position — the console email
 * provider logs "[email] Verify your DMARC Harbor email for <address>"
 * immediately before the message body containing the link.
 */
function findVerifyUrls(email) {
  const candidates = [
    process.env.API_LOG,
    join(homedir(), ".capy", "work", "api-clean.log"),
  ].filter(Boolean);
  try {
    const dir = join(homedir(), ".capy", "operations");
    for (const f of readdirSync(dir)) {
      if (f.endsWith(".log")) candidates.push(join(dir, f));
    }
  } catch {
    /* operations dir may not exist */
  }

  const found = [];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    const raw = readFileSync(file, "utf8");
    // Control characters in these three patterns are the point: they strip
    // terminal CSI/OSC escape sequences and stray control bytes that corrupt
    // verification tokens extracted from terminal-session logs.
    /* eslint-disable-next-line no-control-regex */
    const escOsc = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g;
    /* eslint-disable-next-line no-control-regex */
    const escCsi = /\x1b\[[0-9;?]*[A-Za-z]/g;
    /* eslint-disable-next-line no-control-regex */
    const controlBytes = /[\x00-\x08\x0b\x0c\x0e-\x1f]/g;
    const text = raw
      .replace(escOsc, "")
      .replace(escCsi, "")
      .replace(controlBytes, "");

    // Clean logs: the link is intact on one line.
    for (const m of text.matchAll(
      new RegExp(
        `Verify your DMARC Harbor email for ${email.replace(/[.+]/g, "\\$&")}[\\s\\S]{0,400}?\\?(?:amp;)?token=([A-Za-z0-9_.-]+)`,
        "g",
      ),
    )) {
      found.push(`/api/auth/verify-email?token=${m[1]}`);
    }

    // Wrapped logs: match on whitespace-collapsed text, position-associated.
    // The matcher derives the host from API_BASE so it works on any port.
    const flat = text.replace(/\s+/g, "");
    const escapedApi = API.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    for (const m of flat.matchAll(
      new RegExp(
        `VerifyyourDMARCHarboremailfor([^[]+?)Verifyyouremailaddressusingthislink:${escapedApi}\\/api\\/auth\\/verify-email\\?token=([A-Za-z0-9_.-]+)`,
        "g",
      ),
    )) {
      if (m[1] === email) found.push(`/api/auth/verify-email?token=${m[2]}`);
    }
  }
  return found;
}

const verifyUrls = findVerifyUrls(ACCOUNT.email);
let verified = false;
for (const path of verifyUrls) {
  const v = await api(path);
  if (v.status < 400) {
    log("verify-email", `ok (status ${v.status}, ${verifyUrls.length} link(s) found)`);
    verified = true;
    break;
  }
}
if (!verified) {
  console.error(
    `[seed] verification failed: ${verifyUrls.length} link(s) found, none accepted. ` +
      `Is the API logging to ${join(homedir(), ".capy", "work", "api-clean.log")}?`,
  );
  process.exit(1);
}

const signIn = await api("/api/auth/sign-in/email", {
  method: "POST",
  body: JSON.stringify({ email: ACCOUNT.email, password: ACCOUNT.password }),
});
const cookie = cookieFrom(signIn.headers);
if (!cookie) {
  console.error("[seed] no session cookie", signIn.status, signIn.body);
  process.exit(1);
}
log("sign-in", String(signIn.status));

// ─── 2. workspace ─────────────────────────────────────────────────────────────

const wsList = await api("/api/workspaces", {}, cookie);
let organizationId = wsList.body?.find((w) => w.slug === WORKSPACE.slug)?.id;
if (!organizationId) {
  const ws = await api(
    "/api/workspaces",
    { method: "POST", body: JSON.stringify(WORKSPACE) },
    cookie,
  );
  log("workspace created", String(ws.status));
  organizationId = ws.body?.id;
} else {
  log("workspace reused", organizationId);
}
if (!organizationId) {
  console.error("[seed] no workspace id", wsList.body);
  process.exit(1);
}

// Plan headroom for a multi-client portfolio. The plan-change and override
// routes are staff-only by deliberate design (see entitlement.routes.ts: the
// owner could otherwise self-grant Admiralty), so — exactly as the API's own
// test suite does (billing-state.integration.test.ts) — the subscription row
// is written directly. Test-harness setup only; the app never does this. This
// must happen BEFORE client creation: the free plan allows one client, so the
// quota check below would otherwise refuse every client after the first.
const { PrismaClient } = await import("@prisma/client");
const prisma = new PrismaClient();
await prisma.subscription.deleteMany({ where: { organizationId } });
await prisma.subscription.create({
  data: { organizationId, plan: "HARBOR", status: "ACTIVE", provider: "NONE" },
});
log("plan headroom", "subscription HARBOR via test pattern");

// ─── 3. clients + domains (idempotent) ────────────────────────────────────────

const CLIENTS = [
  {
    name: "Acme Freight",
    slug: "acme-freight",
    domains: ["acmefreight.com", "portal.acmefreight.com"],
  },
  { name: "Northgate HR", slug: "northgate-hr", domains: ["northgate-hr.co.uk"] },
  {
    name: "Brightline Studio",
    slug: "brightline",
    domains: ["brightline.io", "mail.brightline.io"],
  },
  { name: "Harbor Clinic", slug: "harbor-clinic", domains: ["harborclinic.org"] },
  { name: "Meridian Legal", slug: "meridian-legal", domains: ["meridianlaw.com"] },
  {
    name: "Sable Logistics",
    slug: "sable-logistics",
    domains: ["sablelogistics.com", "go.sablelogistics.com"],
  },
];

const existingClients = await api(`/api/workspaces/${organizationId}/clients`, {}, cookie);
const bySlug = new Map((existingClients.body ?? []).map((c) => [c.slug, c]));

const domainIds = [];
for (const c of CLIENTS) {
  let client = bySlug.get(c.slug);
  if (!client) {
    const res = await api(
      `/api/workspaces/${organizationId}/clients`,
      { method: "POST", body: JSON.stringify({ name: c.name, slug: c.slug }) },
      cookie,
    );
    client = res.body;
  }
  if (!client?.id) {
    console.error("[seed] client failed", c.slug);
    continue;
  }
  const domList = await api(
    `/api/workspaces/${organizationId}/clients/${client.id}/domains`,
    {},
    cookie,
  );
  const domByName = new Map((domList.body ?? []).map((d) => [d.name, d]));
  for (const d of c.domains) {
    let dom = domByName.get(d);
    if (!dom) {
      const res = await api(
        `/api/workspaces/${organizationId}/clients/${client.id}/domains`,
        { method: "POST", body: JSON.stringify({ name: d }) },
        cookie,
      );
      dom = res.body;
    }
    if (dom?.id) domainIds.push({ name: d, id: dom.id });
    else console.error("[seed] domain failed", d);
  }
}
log("clients + domains", `${domainIds.length} domains`);

// Ingestion requires a verified domain. The API's own test suite sets this
// directly (prisma.user/domain.update with VERIFIED — see
// tests/client.integration.test.ts:135) because fake domains cannot pass a
// real DNS ownership check. We follow that established test pattern; the app
// itself never does this.
const { PrismaClient: PrismaClient2 } = await import("@prisma/client");
const prisma2 = new PrismaClient2();
await prisma2.domain.updateMany({
  where: { id: { in: domainIds.map((d) => d.id) } },
  data: { status: "VERIFIED", verifiedAt: new Date() },
});
log("domains verified", "via test pattern (fake domains cannot pass real DNS)");
await prisma2.$disconnect();

// ─── 4. aggregate reports → four postures ────────────────────────────────────
//
//   acmefreight.com         → block       (failures observed)
//   portal.acmefreight.com  → unverified  (unattributed sender, 60% of volume)
//   go.sablelogistics.com   → unverified  (unattributed sender, 55% of volume)
//   northgate-hr.co.uk      → pass        (clean, fresh)
//   brightline.io           → pass        (clean, fresh)
//   meridianlaw.com         → pass        (clean, fresh)
//   sablelogistics.com      → pass        (clean, fresh)
//   mail.brightline.io      → unmeasured  (feed stale — reports 12 days old)
//   harborclinic.org        → unmeasured  (never reported)

function aggregateXml({ domain, records, begin, end, reportId }) {
  const recs = records
    .map(
      (r) => `
  <record>
    <row>
      <source_ip>${r.ip}</source_ip>
      <count>${r.count}</count>
      <policy_evaluated>
        <disposition>${r.disposition}</disposition>
        <dkim>${r.dkim}</dkim>
        <spf>${r.spf}</spf>
      </policy_evaluated>
    </row>
    <identifiers>
      <header_from>${r.headerFrom ?? domain}</header_from>
    </identifiers>
    <auth_results>
      <dkim>
        <domain>${r.dkimDomain ?? domain}</domain>
        <result>${r.dkim}</result>
      </dkim>
      <spf>
        <domain>${r.spfDomain ?? domain}</domain>
        <scope>mfrom</scope>
        <result>${r.spf}</result>
      </spf>
    </auth_results>
  </record>`,
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<feedback>
  <report_metadata>
    <org_name>seed-reporter</org_name>
    <email>postmaster@seed-reporter.test</email>
    <report_id>${reportId}</report_id>
    <date_range>
      <begin>${begin}</begin>
      <end>${end}</end>
    </date_range>
  </report_metadata>
  <policy_published>
    <domain>${domain}</domain>
    <adkim>r</adkim>
    <aspf>r</aspf>
    <p>none</p>
    <sp>none</sp>
  </policy_published>${recs}
</feedback>`;
}

const day = (offset) => Math.floor((Date.now() - offset * 86_400_000) / 1000);

const HISTORIES = {
  "acmefreight.com": [
    { offset: 1, fail: 120 },
    { offset: 2, fail: 40 },
    { offset: 3, fail: 0 },
  ],
  "portal.acmefreight.com": [{ offset: 1, unattr: 0.6 }],
  "northgate-hr.co.uk": [{ offset: 1 }, { offset: 2 }],
  "brightline.io": [{ offset: 1 }],
  "mail.brightline.io": [{ offset: 12 }, { offset: 13 }],
  "harborclinic.org": [],
  "meridianlaw.com": [{ offset: 1 }],
  "sablelogistics.com": [{ offset: 1 }],
  "go.sablelogistics.com": [{ offset: 1, unattr: 0.55 }],
};

let ingested = 0;
for (const d of domainIds) {
  const history = HISTORIES[d.name] ?? [];
  for (const h of history) {
    const base = [
      { ip: "198.51.100.7", count: 4200, disposition: "none", dkim: "pass", spf: "pass" },
    ];
    if (h.unattr) {
      // Authentication PASSES, but as a different domain than the one
      // monitored — seen traffic we cannot attribute. That is the unverified
      // posture: an open question, never a pass.
      base.push({
        ip: "203.0.113.44",
        count: Math.round(4200 * h.unattr),
        disposition: "none",
        dkim: "pass",
        spf: "pass",
        headerFrom: d.name,
        dkimDomain: "unattributed-sender.test",
        spfDomain: "unattributed-sender.test",
      });
    }
    if (h.fail) {
      base.push({
        ip: "192.0.2.88",
        count: h.fail,
        disposition: "none",
        dkim: "fail",
        spf: "fail",
      });
    }
    const xml = aggregateXml({
      domain: d.name,
      records: base,
      begin: day(h.offset + 1),
      end: day(h.offset),
      reportId: `seed-${d.name}-${h.offset}`,
    });
    const res = await api(
      `/api/workspaces/${organizationId}/domains/${d.id}/reports`,
      { method: "POST", body: JSON.stringify({ xml }) },
      cookie,
    );
    if (res.status < 300) ingested += 1;
    else if (res.status !== 409) console.error("[seed] report failed", d.name, res.status, res.body);
  }
}
log("reports ingested", String(ingested));

// lastReportAt is the ingestion time (receivedAt), so a report ingested now
// with an old date range still reads as fresh. Backdate the stale domain's
// reports to make the feed genuinely old — the honest state for a domain whose
// reporters stopped sending.
const p2 = new PrismaClient();
await p2.dmarcReport.updateMany({
  where: { domain: { name: "mail.brightline.io" } },
  data: { receivedAt: new Date(Date.now() - 12 * 86_400_000) },
});
await p2.$disconnect();
log("stale feed backdated", "mail.brightline.io → 12 days");

log("done", `sign in at http://localhost:3100/sign-in as ${ACCOUNT.email}`);
log("password", ACCOUNT.password);
