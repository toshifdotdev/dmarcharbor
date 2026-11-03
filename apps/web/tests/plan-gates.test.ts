import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PLAN_FEATURE_KEYS, UNLISTED_FEATURES } from "../lib/plan-features";

/**
 * Every plan-gated feature and every quota is gated in the UI, not only in the
 * API.
 *
 * The API refuses a feature the plan lacks with a 402. A screen that still
 * offers the form for it is a form that fails after someone has filled it in,
 * so each gated key must be read and explained wherever it is offered. This
 * test reads the app's source (app/, components/, lib/; comments stripped) and
 * fails when a gated key has no gate, which is what happens when a key is
 * added to the plan comparison (lib/plan-features.ts) and to the API with no
 * screen change.
 *
 * What counts, per key (any of the gate forms, and an explanation):
 *
 *   gate         featureOf(entitlements, "key"): the plan read on the
 *                server (or in the browser) before the control is offered.
 *                Three screens gate at the read instead, because the read
 *                itself answers 402 on a plan without the feature (SSO, the
 *                report mailbox, TLS reports): there the 402 branch
 *                (`status === 402`) in the same file is the gate.
 *   explanation  feature="key" on an UpgradeNotice, or data-feature="key" on
 *                a smaller note (the usage CSV, the assistant): what the
 *                person reads instead of the form, naming the plan.
 *
 * Quotas: each limit the API enforces must be shown before it is met (a usage
 * line) and said when it is met (a PlanLimitNotice in place of the form), and
 * the API's refusal codes must be routed somewhere.
 */

const WEB = fileURLToPath(new URL("..", import.meta.url));

/** On every plan, so there is nothing to gate (the API's alwaysOn and alwaysAllowed lists). */
const ON_EVERY_PLAN = new Set(["reports.aggregate", "audit.trail", "data.export", "data.erase"]);

/** Keys gated where the read itself is refused, so the 402 branch is the gate. */
const READ_GATED = new Set(["auth.sso", "reports.inbox", "reports.tlsrpt"]);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "tests" || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith(".d.ts")) out.push(path);
  }
  return out;
}

/** Block, JSX and line comments out, so a key named in a comment is not a gate. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

const files = ["app", "components", "lib"].flatMap((d) => sourceFiles(join(WEB, d)));
const sources = files.map((path) => ({ path: path.slice(WEB.length), text: stripComments(readFileSync(path, "utf8")) }));
const all = sources.map((s) => s.text).join("\n");

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const quoted = (key: string) => `["'\`]${esc(key)}["'\`]`;

function gateFor(key: string): RegExp {
  return new RegExp(`featureOf\\(\\s*[^,()]+,\\s*${quoted(key)}\\s*\\)`);
}

function explanationFor(key: string): RegExp {
  return new RegExp(`(?:^|[\\s{(])(?:data-)?feature=(?:${quoted(key)}|\\{\\s*${quoted(key)}\\s*\\})`);
}

const gated = PLAN_FEATURE_KEYS.filter((k) => !ON_EVERY_PLAN.has(k) && !UNLISTED_FEATURES.has(k));

describe("the plan comparison's keys", () => {
  it("lists the web's every EntitlementKey (lib/types.ts), so none escapes this test", () => {
    const types = readFileSync(join(WEB, "lib", "types.ts"), "utf8");
    const union = /export type EntitlementKey =([\s\S]*?);/.exec(types)?.[1] ?? "";
    const keys = [...union.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
    expect(keys.length).toBeGreaterThan(20);
    const listed = new Set([...PLAN_FEATURE_KEYS, ...UNLISTED_FEATURES]);
    expect(keys.filter((k) => !listed.has(k))).toEqual([]);
  });

  it("has gated keys to check", () => {
    expect(gated.length).toBeGreaterThan(20);
    expect(gated).toContain("alerts.email");
  });
});

describe("every gated feature has a gate in the UI", () => {
  it.each(gated)("%s is read before it is offered", (key) => {
    if (READ_GATED.has(key)) {
      const explaining = sources.filter((s) => explanationFor(key).test(s.text));
      expect(explaining.some((s) => /status\s*===\s*402/.test(s.text) || /notInPlan/.test(s.text))).toBe(true);
      return;
    }
    expect(gateFor(key).test(all)).toBe(true);
  });

  it.each(gated)("%s is explained with the plan that has it", (key) => {
    expect(explanationFor(key).test(all)).toBe(true);
  });
});

describe("every quota the API enforces is shown and said in the UI", () => {
  const usage: Record<string, RegExp> = {
    client: /<UsageLine[^>]*quota="client"/,
    activeDomain: /<UsageLine[^>]*quota="activeDomain"/,
    member: /<UsageLine[^>]*quota="member"/,
    workspace: /data-testid="workspace-allowance"/,
    prospect: /data-testid="prospects-usage"/,
  };
  const reached: Record<string, RegExp> = {
    client: /<PlanLimitNotice[^>]*quota="client"/,
    activeDomain: /<PlanLimitNotice[^>]*quota="activeDomain"/,
    member: /<PlanLimitNotice[^>]*quota="member"/,
    workspace: /<PlanLimitNotice[^>]*quota="workspace"/,
    prospect: /<PlanLimitNotice[^>]*quota="prospect"/,
  };

  it.each(Object.keys(usage))("%s: usage is shown before the limit", (quota) => {
    expect(usage[quota]!.test(all)).toBe(true);
  });

  it.each(Object.keys(reached))("%s: the limit replaces the form when it is met", (quota) => {
    expect(reached[quota]!.test(all)).toBe(true);
  });

  it.each(["PLAN_LIMIT_REACHED", "WORKSPACE_LIMIT_REACHED", "PROSPECT_LIMIT_REACHED", "FEATURE_NOT_IN_PLAN"])(
    "the API's %s is routed to an upgrade notice",
    (code) => {
      expect(all.includes(`"${code}"`)).toBe(true);
    },
  );

  it("a refused downgrade has words for every quota row, workspaces included", () => {
    const board = sources.find((s) => s.path.replace(/\\/g, "/").endsWith("components/harbor/billing-board.tsx"));
    expect(board).toBeDefined();
    for (const quota of ["client", "activeDomain", "member", "workspace"]) {
      expect(new RegExp(`\\b${quota}: "`).test(board!.text)).toBe(true);
    }
  });
});
