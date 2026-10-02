/**
 * clickthrough.mjs — Phase verification: drive a real Chrome through the sign
 * -in form and the portfolio, exactly as a person would, and save screenshots.
 * Dev tooling, not shipped code.
 *
 * Prereqs: API on :4000, web on :3100, seed.mjs already run.
 * Run: node scripts/clickthrough.mjs
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const WEB = process.env.WEB_BASE ?? "http://localhost:3100";
const CDP = "http://127.0.0.1:9222";
const SHOTS = join(homedir(), ".capy", "work", "phase1-shots");
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
}

// ─── 1. web server must be up ─────────────────────────────────────────────────

async function waitFor(url, timeoutMs = 90_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { redirect: "manual" });
      return res.status;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  return 0;
}

const webStatus = await waitFor(`${WEB}/sign-in`);
check("web server up", webStatus > 0, `GET /sign-in → ${webStatus}`);
if (!webStatus) process.exit(1);

// ─── 2. launch Chrome with CDP ───────────────────────────────────────────────

mkdirSync(SHOTS, { recursive: true });
const profile = join(homedir(), ".capy", "work", "chrome-ct-profile");
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    "--remote-debugging-port=9222",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--window-size=1440,2000",
    "about:blank",
  ],
  { stdio: "ignore", detached: false },
);

await waitFor(`${CDP}/json/version`, 30_000);

async function newTarget(url) {
  const endpoint = `${CDP}/json/new?${encodeURIComponent(url)}`;
  for (const method of ["PUT", "GET"]) {
    const res = await fetch(endpoint, { method });
    if (res.ok) return res.json();
  }
  throw new Error("could not open a CDP target");
}

const target = await newTarget("about:blank");
const ws = new WebSocket(target.webSocketDebuggerUrl, {
  perMessageDeflate: false,
  maxPayload: 256 * 1024 * 1024,
});
await new Promise((resolve, reject) => {
  ws.once("open", resolve);
  ws.once("error", reject);
});

let seq = 0;
const pending = new Map();
ws.on("message", (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
  }
});
function cdp(method, params = {}) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

await cdp("Page.enable");
await cdp("Runtime.enable");

async function navigate(url) {
  await cdp("Page.navigate", { url });
  for (let i = 0; i < 60; i++) {
    const r = await cdp("Runtime.evaluate", {
      expression: "document.readyState",
      returnByValue: true,
    });
    if (r.result.value === "complete") return;
    await new Promise((res) => setTimeout(res, 250));
  }
}

async function evalJs(expression) {
  const r = await cdp("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  return r.result.value;
}

async function shot(name) {
  const r = await cdp("Page.captureScreenshot", { format: "png" });
  const file = join(SHOTS, name);
  writeFileSync(file, Buffer.from(r.data, "base64"));
  return file;
}

// ─── 3. the click-through ─────────────────────────────────────────────────────

// 3a. the sign-in page renders
await navigate(`${WEB}/sign-in`);
const signInHeading = await evalJs("document.querySelector('h1')?.textContent ?? ''");
check("sign-in page renders", signInHeading.includes("DMARC Harbor"), signInHeading.trim());
const shotSignIn = await shot("01-sign-in.png");

// 3b. fill the form and click sign in — the real React form, real inputs
await evalJs(`
  (() => {
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    const email = document.querySelector('input[type="email"]');
    const pass = document.querySelector('input[type="password"]');
    set.call(email, 'sam@northgate.test');
    email.dispatchEvent(new Event('input', { bubbles: true }));
    set.call(pass, 'harbor-test-2026');
    pass.dispatchEvent(new Event('input', { bubbles: true }));
    return 'filled';
  })()
`);
await evalJs("document.querySelector('button[type=submit]').click(); 'clicked'");

// the form redirects to / on success; poll for the portfolio actually being
// visible (Next dev compiles the page on first hit, which can take a while)
for (let i = 0; i < 240; i++) {
  const state = await evalJs(
    `({ path: location.pathname, rows: document.querySelectorAll('tbody tr').length, err: (document.querySelector('[role=alert]')?.textContent ?? '').trim() })`,
  );
  if (state.path === "/" && state.rows > 0) break;
  if (state.err) {
    check("sign-in navigates to portfolio", false, `form error: ${state.err}`);
    process.exit(1);
  }
  await new Promise((res) => setTimeout(res, 250));
}
const finalState = await evalJs(
  `({ path: location.pathname, rows: document.querySelectorAll('tbody tr').length })`,
);
check(
  "sign-in navigates to portfolio",
  finalState.path === "/" && finalState.rows > 0,
  `landed on ${finalState.path} with ${finalState.rows} rows`,
);

// give the portfolio's parallel signal fetches time to resolve
await new Promise((res) => setTimeout(res, 2500));
await navigate(WEB + "/");
await new Promise((res) => setTimeout(res, 1500));

// 3c. the portfolio grid: rows, postures, Rule Zero
const grid = await evalJs(`
  (() => {
    const rows = [...document.querySelectorAll('tbody tr')].map(tr =>
      [...tr.querySelectorAll('td')].map(td => td.textContent.trim())
    );
    return {
      rowCount: rows.length,
      sample: rows.slice(0, 3),
      bodyHasPending: document.body.textContent.includes('Signals pending'),
      postureWords: ['Aligned','Blocking','Unverified','Stale','Not measured'].map(w => [w, document.body.textContent.includes(w)]),
      totals: [...document.querySelectorAll('.num')].slice(-6).map(n => n.textContent.trim()),
    };
  })()
`);
check(
  "portfolio renders domain rows",
  grid.rowCount >= 9,
  `${grid.rowCount} rows (expect 9 domains)`,
);
const labels = grid.postureWords.filter(([, present]) => present).map(([w]) => w);
check(
  "all five postures visible",
  labels.length === 5,
  `found: ${labels.join(", ") || "none"}`,
);

// Toolbar: the counts ARE the filters (no separate stat row).
const chips = await evalJs(
  `[...document.querySelectorAll('button[aria-pressed]')].map(b => b.textContent.trim())`,
);
const chipsOk =
  chips.some((t) => t.startsWith("Blocking")) &&
  chips.some((t) => t.startsWith("Stale")) &&
  chips.some((t) => t.startsWith("All")) &&
  chips.every((t) => /\d/.test(t));
check(
  "toolbar: posture counts are the filters",
  chipsOk,
  JSON.stringify(chips),
);

// Bug 2: the policy column must come from evidence (policy_published in the
// reports), never from the DNS-scan field that says "no record" unscanned.
const policyAudit = await evalJs(`
  (() => {
    const rows = [...document.querySelectorAll('tbody tr')];
    const out = {};
    for (const tr of rows) {
      const t = tr.textContent;
      for (const d of ['acmefreight.com', 'harborclinic.org']) {
        if (t.includes(d)) out[d] = (t.match(/p=(none|quarantine|reject)/) ?? ['not-observed'])[0];
      }
    }
    return out;
  })()
`);
check(
  "policy column is evidence-based (Bug 2)",
  policyAudit["acmefreight.com"] === "p=none" && policyAudit["harborclinic.org"] === "not-observed",
  JSON.stringify(policyAudit),
);
const shotPortfolio = await shot("02-portfolio.png");

// 3d. the two silences must read as DIFFERENT facts, and neither may look
//     like a pass. Stale = measured then quiet; Not measured = never.
const silenceAudit = await evalJs(`
  (() => {
    const rows = [...document.querySelectorAll('tbody tr')];
    const out = [];
    for (const tr of rows) {
      const text = tr.textContent;
      if (text.includes('harborclinic.org') || text.includes('mail.brightline.io')) {
        out.push({
          domain: text.includes('harborclinic.org') ? 'harborclinic.org' : 'mail.brightline.io',
          hasAligned: text.includes('Aligned'),
          hasStale: text.includes('Stale'),
          hasNotMeasured: text.includes('Not measured'),
        });
      }
    }
    return out;
  })()
`);
const byDomain = Object.fromEntries(silenceAudit.map((r) => [r.domain, r]));
const ruleZero =
  silenceAudit.length === 2 &&
  byDomain["mail.brightline.io"]?.hasStale === true &&
  byDomain["mail.brightline.io"]?.hasNotMeasured === false &&
  byDomain["harborclinic.org"]?.hasNotMeasured === true &&
  byDomain["harborclinic.org"]?.hasStale === false &&
  silenceAudit.every((r) => !r.hasAligned);
check(
  "Rule Zero: stale and never-measured read as different facts, neither is a pass",
  ruleZero,
  JSON.stringify(silenceAudit),
);

console.log("\nshots:", shotSignIn, shotPortfolio);

// ─── 4. Phase 2: the evidence screens ─────────────────────────────────────────

// Clicking needs React hydration first: a .click() before hydration attaches is
// a silent no-op. Wait for the React marker on the row, then click; fall back to
// invoking React's own onClick prop directly so the click is deterministic.
// After the click lands, HARD-LOAD the destination: Next's route transition
// keeps the outgoing DOM visible while the new page streams in, so a text
// read during the transition blends both pages and can never be trusted.
async function openDomain(matchText) {
  const escaped = matchText ? matchText.replace(/['\\]/g, "\\$&") : null;
  const rowExpr = escaped
    ? `[...document.querySelectorAll('tbody tr')].find(tr => tr.textContent.includes('${escaped}'))`
    : `document.querySelector('tbody tr')`;
  await waitForEval(
    `(() => { const row = ${rowExpr}; return row ? Object.keys(row).some(k => k.startsWith('__react')) : false; })()`,
    (v) => v === true,
    30_000,
  );
  // ONE click per attempt. Re-clicking while a route transition is in flight
  // restarts it each time (router.push aborts the previous transition), so a
  // click loop can starve the navigation it is waiting for. Click, then watch;
  // only click again after giving the transition a full window to land.
  for (let attempt = 0; attempt < 3; attempt++) {
    await evalJs(`(() => { const row = ${rowExpr}; if (row) row.click(); return true; })()`);
    for (let i = 0; i < 120; i++) {
      const path = await evalJs("location.pathname");
      if (path.startsWith("/domains/")) {
        await navigate(WEB + path);
        return path;
      }
      await new Promise((res) => setTimeout(res, 500));
    }
  }
  return await evalJs("location.pathname");
}

async function waitForEval(expression, predicate, timeoutMs = 90_000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    last = await evalJs(expression);
    if (predicate(last)) return last;
    await new Promise((res) => setTimeout(res, 500));
  }
  return last;
}

// 4a. clicking a portfolio row opens the domain detail.
// Warm the route first: the first visit cold-compiles the detail page in dev,
// which can outlast the click poll. The measured click below then tests
// navigation, not compile latency.
await fetch(`${WEB}/domains/warmup-compile`).catch(() => {});
await navigate(WEB + "/");
await waitForEval("document.querySelectorAll('tbody tr').length", (n) => n > 0);
const detailPath = await openDomain(null);
check(
  "portfolio row opens domain detail",
  detailPath.startsWith("/domains/"),
  `landed on ${detailPath}`,
);

// 4b. the evidence panels render — poll, since dev compiles on first hit
const detail = await waitForEval(
  `(() => {
    const t = document.body.textContent;
    return {
      hasChart: !!document.querySelector('figure svg'),
      hasSenders: t.includes('Senders'),
      hasReports: t.includes('Aggregate reports'),
      hasReadiness: t.includes('Policy posture'),
      headings: [...document.querySelectorAll('h1,h2')].map(h => h.textContent.trim()).slice(0, 8),
    };
  })()`,
  (d) => d && d.hasChart && d.hasSenders && d.hasReports && d.hasReadiness,
);
check(
  "domain detail renders evidence panels",
  Boolean(detail && detail.hasChart && detail.hasSenders && detail.hasReports && detail.hasReadiness),
  detail ? detail.headings.join(" | ") : "no detail",
);
const shotDetail = await shot("03-domain-detail.png");

// 4c. the stale-feed domain: blackout band + hatched chart gap, no pass.
// Read the row id from the PORTFOLIO (the detail page's tables have no such
// row), then navigate directly: the posture truth is the same whether the user
// clicked or typed the URL, and the row click itself is proven by 4a. The
// assertion reads the posture BADGE (data-testid), never page-wide text, so no
// other screen's chips can leak in.
await navigate(WEB + "/");
await waitForEval("document.querySelectorAll('tbody tr').length", (n) => n > 0);
const staleId = await evalJs(
  `([...document.querySelectorAll('tbody tr')].find(tr => tr.textContent.includes('mail.brightline.io'))?.dataset.domainId ?? '')`,
);
if (!staleId) {
  check("stale feed shows blackout, not health", false, "portfolio row for mail.brightline.io not found");
  process.exit(1);
}
const stalePath = `/domains/${staleId}`;
await navigate(WEB + stalePath);
const staleAudit = await waitForEval(
  `(() => {
    const badge = document.querySelector('[data-testid="posture-badge"]')?.textContent.trim() ?? '';
    const t = document.body.textContent;
    return {
      badge,
      blackout: t.includes('The feed went quiet') || t.includes('No aggregate report'),
      hatchCells: document.querySelectorAll('rect[fill="url(#void-hatch)"]').length,
    };
  })()`,
  (a) => a && (a.badge !== "" || a.blackout),
);
check(
  "stale feed shows its own posture, not health",
  Boolean(
    staleAudit &&
      staleAudit.badge === "Stale" &&
      staleAudit.blackout &&
      staleAudit.hatchCells > 0,
  ),
  `${stalePath} ${JSON.stringify(staleAudit)}`,
);
const shotStale = await shot("04-stale-blackout.png");

// 4d. the never-reported domain must show the loudest silence
await navigate(WEB + "/");
await waitForEval("document.querySelectorAll('tbody tr').length", (n) => n > 0);
const emptyId = await evalJs(
  `([...document.querySelectorAll('tbody tr')].find(tr => tr.textContent.includes('harborclinic.org'))?.dataset.domainId ?? '')`,
);
const emptyPath = `/domains/${emptyId}`;
await navigate(WEB + emptyPath);
const emptyAudit = await waitForEval(
  `(() => {
    const badge = document.querySelector('[data-testid="posture-badge"]')?.textContent.trim() ?? '';
    const t = document.body.textContent;
    return {
      badge,
      neverReported: t.includes('No aggregate report has ever been received'),
    };
  })()`,
  (a) => a && (a.badge !== "" || a.neverReported),
);
check(
  "never-reported domain renders the loudest silence",
  Boolean(
    emptyAudit &&
      emptyAudit.badge === "Not measured" &&
      emptyAudit.neverReported,
  ),
  `${emptyPath} ${JSON.stringify(emptyAudit)}`,
);
const shotEmpty = await shot("05-never-reported.png");

console.log("evidence shots:", shotDetail, shotStale, shotEmpty);

// ─── 5. Phase 3: operations screens ─────────────────────────────────────────

// 5a. Alerts: the create form carries ALL NINE fields the API requires, the
//     silence metric is labelled honestly (its warning appears when the
//     operator selects REPORT_SILENCE — a conditional deserves to be tested
//     in its state, not at rest), and only the three operators the live API
//     accepts are offered (LESS_THAN_OR_EQUAL and EQUAL return 400).
await navigate(WEB + "/alerts");
const alertsAudit = await waitForEval(
  `(() => {
    const t = document.body.textContent;
    const selects = [...document.querySelectorAll('select')];
    const opSelect = selects.find(s => [...s.options].some(o => o.textContent === 'greater than'));
    return {
      hasForm: t.includes('New alert rule'),
      allNine: ['Domain','Rule name','Metric','Operator','Threshold','Window (minutes)','Cooldown (minutes)','Max reminder level','Recipients'].every(f => t.includes(f)),
      escalationShown: t.includes('escalat'),
      operators: opSelect ? [...opSelect.options].map(o => o.textContent) : [],
    };
  })()`,
  (a) => a && a.hasForm && a.operators.length > 0,
);
// Select REPORT_SILENCE and confirm its honesty note appears in that state.
await evalJs(`(() => {
  const sel = [...document.querySelectorAll('select')].find(s => [...s.options].some(o => o.value === 'REPORT_SILENCE'));
  if (!sel) return 'no-metric-select';
  sel.value = 'REPORT_SILENCE';
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  return 'selected';
})()`);
const alertSilenceAudit = await waitForEval(
  `(() => {
    const t = document.body.textContent;
    return { labelled: t.includes('not quiet and not healthy') };
  })()`,
  (a) => a && a.labelled,
);
const operatorsOk =
  JSON.stringify(alertsAudit?.operators ?? []) ===
  JSON.stringify(["greater than", "greater than or equal", "less than"]);
check(
  "alerts form carries all nine fields + honest silence metric",
  Boolean(alertsAudit && alertsAudit.allNine && alertSilenceAudit?.labelled && alertsAudit.escalationShown),
  JSON.stringify({ nine: alertsAudit?.allNine, silence: alertSilenceAudit?.labelled, escalation: alertsAudit?.escalationShown }),
);
check(
  "alerts offers only the operators the API accepts",
  operatorsOk,
  JSON.stringify(alertsAudit?.operators ?? []),
);
const shotAlerts = await shot("06-alerts.png");

// 5b. Digests: the dayOfMonth cap is explained BEFORE save, not after. The
//     note is conditional (it shows when frequency = monthly), so switch the
//     frequency first — a conditional deserves to be tested in its state.
await navigate(WEB + "/digests");
const digestsFormReady = await waitForEval(
  `(() => {
    const t = document.body.textContent;
    return { hasForm: t.includes('New digest'), frequency: t.includes('Frequency') };
  })()`,
  (d) => d && d.hasForm,
);
await evalJs(`(() => {
  const sel = [...document.querySelectorAll('select')].find(s => [...s.options].some(o => o.value === 'MONTHLY'));
  if (sel) { sel.value = 'MONTHLY'; sel.dispatchEvent(new Event('change', { bubbles: true })); }
  return true;
})()`);
const digestsAudit = await waitForEval(
  `(() => {
    const t = document.body.textContent;
    return {
      capExplained: t.includes('Capped at the 28th on purpose'),
      forensicGated: t.includes('not available on your current plan') || t.includes('Include forensic evidence'),
    };
  })()`,
  (d) => d && (d.capExplained || d.forensicGated),
);
check(
  "digests explain the dayOfMonth cap before save",
  Boolean(digestsFormReady && digestsFormReady.hasForm && digestsAudit && digestsAudit.capExplained && digestsAudit.forensicGated),
  JSON.stringify(digestsAudit),
);
const shotDigests = await shot("07-digests.png");

// 5c. Settings: five roles (incl. portal) named in full, free GDPR rights,
//     mailbox ports, and the SSO 402 routed BY FEATURE KEY — carried on a
//     data attribute, never as on-screen jargon. innerText, not textContent:
//     inline RSC script payloads carry API keys and are not visible copy.
await navigate(WEB + "/settings");
const settingsAudit = await waitForEval(
  `(() => {
    const t = document.body.innerText.toLowerCase();
    const ssoGate = document.querySelector('[data-feature="auth.sso"]');
    const logoFormVisible = [...document.querySelectorAll('label')].some(l => l.textContent.includes('Client portal logo'));
    const typedUrlInput = [...document.querySelectorAll('input')].some(i => /logo/i.test(i.placeholder ?? '') && /http/i.test(i.placeholder ?? ''));
    return {
      fiveRoles: ['owner','admin','analyst','viewer','portal'].every(r => t.includes(r)),
      gdprFree: t.includes('every plan') && t.includes('never will be'),
      ports: t.includes('993, 143 and 2525'),
      ssoGate: Boolean(ssoGate),
      ssoCopyClean: !t.includes('entitlement key'),
      logoNeverTyped: !typedUrlInput && (logoFormVisible ? (t.includes('never linked') || t.includes('never a typed URL')) : true),
      logoGateOrForm: logoFormVisible || t.includes('white-labelling is not included in this plan'),
    };
  })()`,
  (s) => s && (s.fiveRoles || s.ssoGate),
);
check(
  "settings: five roles, free GDPR rights, mailbox ports",
  Boolean(settingsAudit && settingsAudit.fiveRoles && settingsAudit.gdprFree && settingsAudit.ports && settingsAudit.logoNeverTyped && settingsAudit.logoGateOrForm),
  JSON.stringify(settingsAudit),
);
check(
  "402 routes by feature key (data attribute, no on-screen jargon)",
  Boolean(settingsAudit && settingsAudit.ssoGate && settingsAudit.ssoCopyClean),
  `ssoGate=${settingsAudit?.ssoGate} clean=${settingsAudit?.ssoCopyClean}`,
);
const shotSettings = await shot("08-settings.png");

// 5d. Billing: renders from the API only — every plan's full feature list,
//     limits with NO invented usage, money as integers (no float artifacts),
//     and no raw entitlement keys leaking into the copy.
await navigate(WEB + "/billing");
const billingAudit = await waitForEval(
  `(() => {
    // innerText = rendered copy only (body.textContent also holds inline RSC
    // script payloads, where API keys and build numbers legitimately live).
    // innerText also applies CSS text-transform, so every match is
    // case-insensitive.
    const t = document.body.innerText.toLowerCase();
    return {
      plans: ['mooring','fairway','harbor','admiralty'].every(p => t.includes(p)),
      fullFeatureLists: t.includes('everything in') || t.includes('everything mooring carries'),
      incremental: t.includes('plus'),
      comparison: t.includes('every capability, by plan'),
      gdprFree: t.includes('export of personal data') && t.includes('erasure of personal data'),
      limitsOnly: t.includes('clients · ') && t.includes('active domains'),
      noJargon: !t.includes('entitlement key') && !t.includes('reports.forensic'),
      floatArtifacts: (t.match(/\\d+\\.\\d{3,}/g) ?? []),
      hasUsageBar: !!document.querySelector('[role="progressbar"], progress'),
    };
  })()`,
  (b) => b && b.plans,
);
check(
  "billing shows every plan's full detail (features + comparison)",
  Boolean(billingAudit && billingAudit.plans && billingAudit.fullFeatureLists && billingAudit.comparison),
  JSON.stringify({ features: billingAudit?.fullFeatureLists, comparison: billingAudit?.comparison }),
);
check(
  "billing renders limits only — no invented usage, no usage bar, no jargon",
  Boolean(
    billingAudit &&
      billingAudit.limitsOnly &&
      billingAudit.noJargon &&
      !billingAudit.hasUsageBar &&
      billingAudit.floatArtifacts.length === 0,
  ),
  JSON.stringify({
    limits: billingAudit?.limitsOnly,
    jargon: billingAudit?.noJargon,
    floats: billingAudit?.floatArtifacts,
    usageBar: billingAudit?.hasUsageBar,
  }),
);
check(
  "billing: data export and erasure stated as free on every plan",
  Boolean(billingAudit && billingAudit.gdprFree),
  `gdpr=${billingAudit?.gdprFree}`,
);
const shotBilling = await shot("09-billing.png");

console.log(
  "operations shots:",
  shotAlerts,
  shotDigests,
  shotSettings,
  shotBilling,
);

// ─── 6. Phase 4: the public artefacts and the client portal ──────────────────

// 6a. First mint the artefacts the way an operator would — through the real
//     API paths, while still signed in: publish a client Trust Center link and
//     issue a compliance pack (whose reference and digest the verifier will
//     check end to end).
const artefacts = await evalJs(`(async () => {
  const ws = await (await fetch('/api/workspaces', { credentials: 'include' })).json();
  const orgId = ws[0].id;
  const clients = await (await fetch('/api/workspaces/' + orgId + '/clients', { credentials: 'include' })).json();
  const clientId = clients[0].id;
  const trust = await (await fetch('/api/workspaces/' + orgId + '/clients/' + clientId + '/trust-center', {
    method: 'POST', credentials: 'include',
  })).json();
  const pack = await fetch('/api/workspaces/' + orgId + '/clients/' + clientId + '/compliance-packs', {
    method: 'POST', credentials: 'include',
  });
  return {
    orgId,
    clientId,
    slug: trust.slug ?? '',
    packReference: pack.headers.get('x-dmarc-pack-reference') ?? '',
    packSha: pack.headers.get('x-dmarc-pack-sha256') ?? '',
    packStatus: pack.status,
  };
})()`);
const trustSlug = artefacts?.slug ?? "";

// The Trust Center and verifier are PUBLIC: cookies are cleared so a signed-out
// auditor must be able to read both. Same for the verifier.
await cdp("Network.clearBrowserCookies");
await navigate(WEB + `/trust/${trustSlug}`);
const trustAudit = await waitForEval(
  `(() => {
    const t = document.body.innerText.toLowerCase();
    return {
      rendered: t.includes('trust center') || t.includes('what we hold'),
      noAuthWall: !t.includes('sign in to') && !t.includes('create an account'),
      noConsoleChrome: !t.includes('portfolio') || t.includes('trust center'),
      dataHeld: t.includes('what is held'),
      subProcessors: t.includes('sub-processors'),
      gdprFree: t.includes('not a paid feature'),
    };
  })()`,
  (a) => a && (a.rendered || a.noAuthWall),
);
check(
  "Trust Center loads signed-out (public by contract)",
  Boolean(trustAudit && trustAudit.rendered && trustAudit.noAuthWall && trustAudit.dataHeld),
  JSON.stringify(trustAudit),
);
const shotTrust = await shot("10-trust-center.png");

await navigate(WEB + (artefacts?.packReference ? `/verify?reference=${artefacts.packReference}` : "/verify"));
const verifyAudit = await waitForEval(
  `(() => {
    const t = document.body.innerText.toLowerCase();
    return {
      rendered: t.includes('compliance pack') && t.includes('sha-256'),
      form: !!document.querySelector('#pack-reference'),
      noAuthWall: !t.includes('sign in to'),
      // End-to-end: the issued pack's digest must appear on the public page.
      digestShown: ${JSON.stringify((artefacts?.packSha ?? "").toLowerCase())} ? t.includes(${JSON.stringify((artefacts?.packSha ?? "").toLowerCase())}) : true,
      referenceShown: ${JSON.stringify(artefacts?.packReference ?? "")} ? t.includes(${JSON.stringify(artefacts?.packReference ?? "").toLowerCase()}) : true,
    };
  })()`,
  (v) => v && v.rendered,
);
check(
  "compliance verifier loads signed-out and matches the issued digest",
  Boolean(verifyAudit && verifyAudit.rendered && verifyAudit.form && verifyAudit.noAuthWall && verifyAudit.digestShown && verifyAudit.referenceShown),
  JSON.stringify(verifyAudit),
);
const shotVerify = await shot("11-compliance-verify.png");

// 6b. The client portal. A contact's view needs a real grant, so mint one
//     through the same POST /portal-access path an operator uses, then read the
//     portal as that account. The boundary check is what matters: forensic
//     data must never render — the only permitted mention of "forensic" is the
//     disclaimer that it is NOT part of this portal.
await navigate(WEB + "/sign-in");
await evalJs(`(() => {
  const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  const email = document.querySelector('input[type="email"]');
  const pass = document.querySelector('input[type="password"]');
  set.call(email, 'sam@northgate.test');
  email.dispatchEvent(new Event('input', { bubbles: true }));
  set.call(pass, 'harbor-test-2026');
  pass.dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector('button[type=submit]').click();
  return 'submitted';
})()`);
await waitForEval("document.querySelectorAll('tbody tr').length", (n) => n > 0);

// Grant this account portal access to the first client — the real endpoint,
// the real body ({ email, displayName }), exactly as an operator would.
const grant = await evalJs(`(async () => {
  const ws = await (await fetch('/api/workspaces', { credentials: 'include' })).json();
  const orgId = ws[0].id;
  const clients = await (await fetch('/api/workspaces/' + orgId + '/clients', { credentials: 'include' })).json();
  const res = await fetch('/api/workspaces/' + orgId + '/clients/' + clients[0].id + '/portal-access', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ email: 'sam@northgate.test', displayName: 'Sam Morgan' }),
  });
  return { status: res.status };
})()`);

await navigate(WEB + "/portal");
const portalAudit = await waitForEval(
  `(() => {
    const t = document.body.innerText.toLowerCase();
    // "forensic" may appear ONLY in the boundary disclaimer.
    const forensicMentions = t.includes('forensic');
    const forensicOnlyInDisclaimer = forensicMentions ? t.includes('not part of this portal') : true;
    return {
      rendered: t.includes('your domains') || t.includes('client reports'),
      denied: t.includes('no client report yet'),
      measurementOnly: t.includes('observed') || t.includes('what the world'),
      noForensicData: !t.includes('retained identities') && !t.includes('affected recipients') && !t.includes('named recipients') && forensicOnlyInDisclaimer,
      gdprNote: t.includes('export and erasure') || t.includes('no cost'),
    };
  })()`,
  (p) => p && (p.rendered || p.denied),
);
check(
  "client portal renders measurement without forensic leakage",
  Boolean(
    portalAudit &&
      portalAudit.rendered &&
      portalAudit.measurementOnly &&
      portalAudit.noForensicData &&
      portalAudit.gdprNote,
  ),
  `grant=${grant?.status} ${JSON.stringify(portalAudit)}`,
);
const shotPortal = await shot("12-client-portal.png");

// The portal's domain view carries the same boundary.
const portalDomainHref = await evalJs(
  `[...document.querySelectorAll('a')].map(a => a.getAttribute('href')).find(h => h && h.startsWith('/portal/domain/')) ?? ''`,
);
if (portalDomainHref) {
  await navigate(WEB + portalDomainHref);
  const domainAudit = await waitForEval(
    `(() => {
      const t = document.body.innerText.toLowerCase();
      const forensicMentions = t.includes('forensic');
      return {
        rendered: t.includes('what was observed') || t.includes('who is sending'),
        noForensicData: !t.includes('retained identities') && !t.includes('affected recipients') && !t.includes('named recipients') && (forensicMentions ? t.includes('not part of this portal') : true),
      };
    })()`,
    (d) => d && d.rendered,
  );
  check(
    "portal domain view holds the forensic boundary",
    Boolean(domainAudit && domainAudit.rendered && domainAudit.noForensicData),
    JSON.stringify(domainAudit),
  );
} else {
  check("portal domain view holds the forensic boundary", false, "no domain link on portal");
}
const shotPortalDomain = await shot("13-portal-domain.png");

console.log("phase 4 shots:", shotTrust, shotVerify, shotPortal, shotPortalDomain);
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed`);
ws.close();
chrome.kill();
process.exit(results.every((r) => r.ok) ? 0 : 1);
