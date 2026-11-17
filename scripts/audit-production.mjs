#!/usr/bin/env node
/**
 * audit-production.mjs — `npm audit --omit=dev`, failing on high or critical,
 * with a short, dated list of advisories accepted on purpose.
 *
 * An entry is allowed only while it has not expired, and a vulnerable package
 * passes only if every advisory behind it, directly or through the packages it
 * depends on, is on the list. Anything else at high or critical fails the run,
 * as `npm audit --audit-level=high --omit=dev` did.
 *
 * Run: node scripts/audit-production.mjs
 */
import { spawnSync } from "node:child_process";

/** Each entry names why it is safe to ship and when it must be looked at again. */
const ACCEPTED = [
  {
    id: "GHSA-fc5q-39xc-vjpf",
    package: "picomatch",
    expires: "2026-12-17",
    reason:
      "ReDoS in picomatch, which has no fixed release yet. Its only path is better-auth's optional vitest peer (vitest > vite, tinyglobby, fdir > picomatch). The test runner is never loaded by the API or the web server, so no request reaches it.",
  },
];

const today = new Date().toISOString().slice(0, 10);
const accepted = new Map(ACCEPTED.filter((entry) => entry.expires >= today).map((entry) => [entry.id, entry]));
for (const entry of ACCEPTED) {
  if (entry.expires < today) console.log(`[audit] ${entry.id} (${entry.package}) expired on ${entry.expires}; it counts again.`);
}

const result = spawnSync("npm", ["audit", "--omit=dev", "--json"], { encoding: "utf8", shell: process.platform === "win32" });
let report;
try {
  report = JSON.parse(result.stdout);
} catch {
  console.error(`[audit] npm audit did not return JSON (exit ${result.status}).`);
  console.error(result.stderr);
  process.exit(1);
}

const vulnerabilities = report.vulnerabilities ?? {};
const ghsa = (url) => (typeof url === "string" ? url.split("/").pop() : null);

/** True when every advisory behind this package is accepted. */
function allowed(name, seen = new Set()) {
  if (seen.has(name)) return true;
  seen.add(name);
  const entry = vulnerabilities[name];
  if (!entry) return true;
  return entry.via.every((via) => (typeof via === "string" ? allowed(via, seen) : accepted.has(ghsa(via.url))));
}

const blocking = Object.values(vulnerabilities).filter(
  (entry) => (entry.severity === "high" || entry.severity === "critical") && !allowed(entry.name),
);
const waived = Object.values(vulnerabilities).filter(
  (entry) => (entry.severity === "high" || entry.severity === "critical") && allowed(entry.name),
);

for (const entry of waived) console.log(`[audit] accepted: ${entry.name} (${entry.severity})`);
for (const entry of accepted.values()) console.log(`[audit] ${entry.id} accepted until ${entry.expires}: ${entry.reason}`);

if (blocking.length > 0) {
  for (const entry of blocking) {
    const advisories = entry.via.map((via) => (typeof via === "string" ? `via ${via}` : `${ghsa(via.url)} ${via.title}`)).join("; ");
    console.error(`[audit] ${entry.severity}: ${entry.name} ${entry.range} — ${advisories}`);
  }
  console.error(`[audit] ${blocking.length} production ${blocking.length === 1 ? "package has" : "packages have"} high or critical advisories.`);
  process.exit(1);
}
console.log("[audit] no unaccepted high or critical advisories in production dependencies.");
