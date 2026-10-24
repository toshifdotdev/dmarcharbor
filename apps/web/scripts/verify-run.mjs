/**
 * verify-run.mjs — one isolated, full clickthrough run. Dev tooling, not
 * shipped code.
 *
 * What it does, in order:
 *   1. applies migrations to the VERIFY database (never the dev one),
 *   2. builds the web app for production into `.next-verify`, so a running
 *      `npm run dev` and its `.next` are left alone,
 *   3. starts the API (:4100), the fail-proxy (:3103) and `next start` (:3200),
 *   4. runs scripts/clickthrough.mjs against them,
 *   5. tears every process tree down, whatever happened.
 *
 * Why a production build: the dev server compiles each route on first visit,
 * which on a machine with little free memory takes long enough to trip waits,
 * and Turbopack's dev cache has crashed mid-run. A production server answers
 * every route the same way each time.
 *
 * Run (from apps/web):  node scripts/verify-run.mjs [--skip-build]
 * Env: VERIFY_DATABASE_URL (default: apps/api/.env's DATABASE_URL with the
 * database renamed to dmarcharbor_verify), CT_API_PORT, CT_PROXY_PORT,
 * CT_WEB_PORT, CT_CDP_PORT. Logs: <tmp>/dmarcharbor-verify/*.log
 */
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const API_DIR = resolve(WEB_DIR, "..", "api");
const API_PORT = process.env.CT_API_PORT ?? "4100";
const PROXY_PORT = process.env.CT_PROXY_PORT ?? "3103";
const WEB_PORT = process.env.CT_WEB_PORT ?? "3200";
const CDP_PORT = process.env.CT_CDP_PORT ?? "9222";
const DIST_DIR = ".next-verify";
const LOGS = join(tmpdir(), "dmarcharbor-verify");
const skipBuild = process.argv.includes("--skip-build");

const WEB_ORIGIN = `http://localhost:${WEB_PORT}`;
const PROXY_ORIGIN = `http://127.0.0.1:${PROXY_PORT}`;

function log(message) {
  console.log(`[verify-run] ${message}`);
}
function die(message) {
  console.error(`[verify-run] ${message}`);
  process.exit(1);
}

// ─── The verify database, and a refusal to run against anything else.
function verifyDatabaseUrl() {
  if (process.env.VERIFY_DATABASE_URL) return process.env.VERIFY_DATABASE_URL;
  const dotenv = readFileSync(join(API_DIR, ".env"), "utf8");
  const line = dotenv.split(/\r?\n/).find((entry) => entry.startsWith("DATABASE_URL="));
  if (!line) die("apps/api/.env has no DATABASE_URL; set VERIFY_DATABASE_URL.");
  const url = new URL(line.slice("DATABASE_URL=".length).trim().replace(/^"|"$/g, ""));
  url.pathname = "/dmarcharbor_verify";
  return url.toString();
}
// On this Docker Desktop machine `localhost:5432` has two listeners: ::1 is a
// WSL relay, IPv4 is Docker's own. Connections through `localhost` were
// refused twice in one afternoon while the container stayed healthy, so the
// harness uses 127.0.0.1 and skips the relay.
const DATABASE_URL = verifyDatabaseUrl().replace("@localhost:", "@127.0.0.1:");
const databaseName = new URL(DATABASE_URL).pathname.slice(1);
if (!databaseName.endsWith("_verify")) {
  die(`Refusing to run: database "${databaseName}" is not a verify database (name must end in _verify). The clickthrough rewrites plans, subscriptions and clients.`);
}

// ─── Process management. Every child is tracked and killed as a tree.
const children = [];
let tornDown = false;
function teardown() {
  if (tornDown) return;
  tornDown = true;
  for (const child of children.reverse()) {
    if (!child.pid || child.exitCode !== null) continue;
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      try { process.kill(child.pid, "SIGKILL"); } catch { /* already gone */ }
    }
  }
}
process.on("exit", teardown);
for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"]) {
  process.on(signal, () => { log(`${signal}, tearing down`); process.exit(130); });
}
process.on("uncaughtException", (error) => { console.error(error); process.exit(1); });

function start(name, args, options) {
  mkdirSync(LOGS, { recursive: true });
  const file = join(LOGS, `${name}.log`);
  const out = createWriteStream(file);
  const child = spawn(process.execPath, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.pipe(out);
  child.stderr.pipe(out);
  child.on("exit", (code) => {
    if (!tornDown) log(`${name} exited early (code ${code}); see ${file}`);
  });
  children.push(child);
  log(`${name} started (pid ${child.pid}), log ${file}`);
  return child;
}

function portInUse(port) {
  return new Promise((resolvePort) => {
    const socket = createConnection({ host: "127.0.0.1", port: Number(port) });
    socket.once("connect", () => { socket.destroy(); resolvePort(true); });
    socket.once("error", () => resolvePort(false));
  });
}

async function waitForHttp(url, child, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null) return false;
    try {
      await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  return false;
}

function run(label, args, options) {
  log(label);
  const result = spawnSync(process.execPath, args, { stdio: "inherit", ...options });
  if (result.status !== 0) die(`${label} failed (exit ${result.status}).`);
}

// ─── 0. Ports must be free: a stale server from an earlier run would answer
//        in place of this one, and the run would test old code.
for (const port of [API_PORT, PROXY_PORT, WEB_PORT, CDP_PORT]) {
  if (await portInUse(port)) die(`Port ${port} is already in use. Stop whatever holds it (an earlier run?) and retry.`);
}

// ─── 1. Migrations on the verify database.
const prismaCli = require.resolve("prisma/build/index.js", { paths: [API_DIR] });
run(`migrating ${databaseName}`, [prismaCli, "migrate", "deploy"], {
  cwd: API_DIR,
  env: { ...process.env, DATABASE_URL },
});

// ─── 2. Isolated production build. `next build` rewrites next-env.d.ts and
//        may add the dist dir's types to tsconfig.json; both are put back so
//        the run leaves no diff behind.
const nextCli = require.resolve("next/dist/bin/next", { paths: [WEB_DIR] });
const webEnv = {
  ...process.env,
  NEXT_DIST_DIR: DIST_DIR,
  NEXT_TELEMETRY_DISABLED: "1",
  // Server components call the API through the fail-proxy, so the
  // failure-injection checks reach server-side fetches too.
  API_BASE_URL: PROXY_ORIGIN,
};
if (skipBuild && existsSync(join(WEB_DIR, DIST_DIR, "BUILD_ID"))) {
  log(`--skip-build: reusing ${DIST_DIR}`);
} else {
  const guarded = ["tsconfig.json", "next-env.d.ts"].map((name) => {
    const path = join(WEB_DIR, name);
    return { path, bytes: existsSync(path) ? readFileSync(path) : null };
  });
  try {
    run(`building into ${DIST_DIR}`, [nextCli, "build"], { cwd: WEB_DIR, env: webEnv });
  } finally {
    for (const { path, bytes } of guarded) if (bytes) writeFileSync(path, bytes);
  }
}

// ─── 3. The stack.
const tsxCli = require.resolve("tsx/cli", { paths: [API_DIR] });
const api = start("api", [tsxCli, "src/server.ts"], {
  cwd: API_DIR,
  env: {
    ...process.env,
    NODE_ENV: "development",
    PORT: API_PORT,
    DATABASE_URL,
    BETTER_AUTH_URL: `http://localhost:${API_PORT}`,
    APP_URL: WEB_ORIGIN,
    CORS_ORIGIN: WEB_ORIGIN,
    // Nothing leaves the machine: emails print to the log, and the social
    // check proves the wiring with a credential Google will refuse.
    EMAIL_PROVIDER: "console",
    GOOGLE_CLIENT_ID: "dummy-clickthrough-client-id",
    GOOGLE_CLIENT_SECRET: "dummy-clickthrough-client-secret",
  },
});
if (!(await waitForHttp(`http://127.0.0.1:${API_PORT}/api/meta`, api, 180_000))) die("API did not come up.");

const proxy = start("fail-proxy", [join(WEB_DIR, "scripts", "fail-proxy.mjs")], {
  cwd: WEB_DIR,
  env: { ...process.env, PORT: PROXY_PORT, UPSTREAM_PORT: API_PORT },
});
if (!(await waitForHttp(`${PROXY_ORIGIN}/api/meta`, proxy, 30_000))) die("fail-proxy did not come up.");

const web = start("web", [nextCli, "start", "-p", WEB_PORT], {
  cwd: WEB_DIR,
  env: {
    ...webEnv,
    // The custom-domain check flips a host from verified to unverified and
    // reads it again; the production brand cache would serve the old state.
    HOST_BRAND_CACHE_FACTOR: "0",
  },
});
if (!(await waitForHttp(`${WEB_ORIGIN}/sign-in`, web, 120_000))) die("web server did not come up.");

// ─── 4. The clickthrough itself.
log(`clickthrough against ${WEB_ORIGIN}`);
const clickthrough = spawn(process.execPath, [join(WEB_DIR, "scripts", "clickthrough.mjs")], {
  cwd: WEB_DIR,
  stdio: "inherit",
  env: {
    ...process.env,
    WEB_BASE: WEB_ORIGIN,
    FAIL_PROXY: PROXY_ORIGIN,
    CT_CDP_PORT: CDP_PORT,
    DATABASE_URL,
  },
});
children.push(clickthrough);
const code = await new Promise((resolveCode) => clickthrough.on("exit", (exitCode) => resolveCode(exitCode ?? 1)));
log(`clickthrough exited ${code}`);
process.exit(code);
