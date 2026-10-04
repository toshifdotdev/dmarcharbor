/**
 * fail-proxy.mjs — test-only harness fixture. NOT app code.
 *
 * Forwards everything to the real API, and can fail one path with a real 500.
 * The click-through's "failed ≠ empty" proof needs a genuine request failure on
 * a server-rendered page: browser URL blocking cannot reach server-side fetches,
 * and a dead API breaks auth before the page renders. This proxy keeps auth and
 * data real and fails exactly one path on command.
 *
 * Usage: node scripts/fail-proxy.mjs   (listens on 3103, forwards to 4100)
 *   POST /__fail/on?path=report-digests   → that path starts returning 500
 *   POST /__fail/off                        → forwarding resumes
 *   POST /__slow/on?path=clients&ms=8000   → that path's answer is delayed
 *   POST /__slow/off                        → delay removed
 *   POST /__caps/on?currencies=INR,USD     → /api/capabilities reports that list
 *   POST /__caps/off                        → capabilities forwards upstream
 *
 * The caps override exists because "the USD tab appears when capabilities says
 * two currencies" needs a capabilities response the real API (Paddle
 * unconfigured) will not produce. The page reads the fixture the same way it
 * reads the real endpoint: the assertion is about the page's wiring, not the
 * API's mood.
 *
 * The slow mode exists because browser network throttling cannot slow a
 * SERVER-side fetch: the portfolio's data call runs inside Next, never through
 * Chrome. A waiting-state check needs the API itself to be slow.
 */
import http from "node:http";

const UPSTREAM_HOST = "127.0.0.1";
const UPSTREAM_PORT = Number(process.env.UPSTREAM_PORT ?? 4100);
const PORT = Number(process.env.PORT ?? 3103);

let failPattern = null;
let slowPattern = null;
let slowMs = 0;
let capsOverride = null;

const server = http.createServer((req, res) => {
  const url = req.url ?? "/";

  if (url.startsWith("/__fail/")) {
    if (url.startsWith("/__fail/on")) {
      const wanted = new URL(url, "http://x").searchParams.get("path") ?? "";
      failPattern = wanted ? new RegExp(wanted.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) : null;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ failing: failPattern ? failPattern.source : null }));
      return;
    }
    failPattern = null;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ failing: null }));
    return;
  }

  if (url.startsWith("/__caps/")) {
    if (url.startsWith("/__caps/on")) {
      const wanted = new URL(url, "http://x").searchParams.get("currencies") ?? "";
      const list = wanted.split(",").map((s) => s.trim()).filter(Boolean);
      capsOverride = {
        currencies: list,
        defaultCurrency: list[0] ?? "INR",
        providers: { razorpay: list.includes("INR"), paddle: list.includes("USD") },
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(capsOverride));
      return;
    }
    capsOverride = null;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ capabilities: null }));
    return;
  }

  if (url.startsWith("/__slow/")) {
    if (url.startsWith("/__slow/on")) {
      const params = new URL(url, "http://x").searchParams;
      const wanted = params.get("path") ?? "";
      slowPattern = wanted ? new RegExp(wanted.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) : null;
      slowMs = Number(params.get("ms") ?? 8000);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ slow: slowPattern ? slowPattern.source : null, ms: slowMs }));
      return;
    }
    slowPattern = null;
    slowMs = 0;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ slow: null }));
    return;
  }

  const forward = () => {
    const upstream = http.request(
      {
        hostname: UPSTREAM_HOST,
        port: UPSTREAM_PORT,
        path: url,
        method: req.method,
        headers: req.headers,
        // Fresh connection per request: keep-alive reuse dropped the compliance
        // PDF mid-stream (ECONNRESET) and surfaced as a phantom 500.
        agent: false,
      },
      (up) => {
        // Hop-by-hop: force a fresh socket per call. Keep-alive reuse against
      // this proxy reset mid-read (run 11's phantom 500 on /exports).
      const headers = { ...up.headers, connection: "close" };
      res.writeHead(up.statusCode ?? 502, headers);
        up.on("error", () => res.destroy());
        res.on("close", () => up.destroy());
        up.pipe(res);
      },
    );
    upstream.on("error", () => {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "UPSTREAM", message: "API unreachable." } }));
    });
    req.on("error", () => upstream.destroy());
    req.pipe(upstream);
  };

  if (failPattern && failPattern.test(url)) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "INTERNAL", message: "Deliberate harness failure." } }));
    return;
  }

  if (capsOverride && url.startsWith("/api/capabilities")) {
    res.writeHead(200, { "content-type": "application/json", connection: "close" });
    res.end(JSON.stringify(capsOverride));
    return;
  }

  if (slowPattern && slowPattern.test(url)) {
    setTimeout(forward, slowMs);
    return;
  }
  forward();
});

server.listen(PORT, () => {
  console.log(`fail-proxy on ${PORT} → ${UPSTREAM_HOST}:${UPSTREAM_PORT}`);
});
