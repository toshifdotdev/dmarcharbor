import type { NextConfig } from "next";

// The rewrite target is fixed at build time, so a missing or wrong value
// produces a build that succeeds and then 500s at runtime for the user. In a
// production build, refuse to build without it. Dev keeps the localhost
// default so `npm run dev` works out of the box.
const API_BASE = process.env.API_BASE_URL ?? "http://localhost:4000";
if (process.env.NODE_ENV === "production" && !process.env.API_BASE_URL) {
  throw new Error(
    "API_BASE_URL is not set. It names the DMARC Harbor API this console proxies /api/* to and is read at build time. Set it (see .env.example) and build again.",
  );
}

/**
 * Origins the DEV SERVER will serve for.
 *
 * Next 16 refuses its plain-HTTP root fallback for any hostname it does not
 * recognise, answering `NotAllowedRootHTTPFallbackError`. That is a real
 * protection against a DNS-rebinding attack pointed at a developer's machine,
 * and it is also what stops white-label testing: the app resolves branding from
 * the request Host, so `portal.linkshift.in` has to actually reach the dev
 * server for any of it to be visible. Without this the page renders with no
 * stylesheet at all - raw serif markup, which looks like a broken build rather
 * than a blocked origin.
 *
 * Local loopback hosts are listed because they are what `npm run dev` is opened
 * as by default. Real domains come from `DEV_ALLOWED_ORIGINS` so this file does
 * not accumulate one agency's hostname every time somebody tests a custom
 * domain; the value is a comma-separated list of hostnames, without ports.
 *
 * Development only. It grants nothing in a production build, where a custom
 * domain is served by the deployment itself and arrives through the real
 * hostname.
 */
const devAllowedOrigins = [
  "localhost",
  "127.0.0.1",
  "[::1]",
  ...(process.env.DEV_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  allowedDevOrigins: devAllowedOrigins,
  /**
   * Security headers.
   *
   * The API sets a Content-Security-Policy through helmet, and it does not help here
   * at all: the API returns JSON and renders no markup, so its CSP governs nothing that
   * a browser parses as a page. This is the only place a policy applies to the document
   * that actually exists, which is why it was missing and why nothing caught it - the
   * API side looked well covered.
   *
   * The policy is strict because this app needs very little. There is no inline script
   * in the served markup (Next ships its own bootstrap), no third-party origin, and no
   * embedded frame. `'unsafe-inline'` is deliberately absent from script-src: it would
   * defeat the point, and if a future change needs it that is a signal to use a nonce
   * rather than to widen the policy.
   *
   * `style-src` does allow 'unsafe-inline' and has to: Next injects style tags for
   * font faces and the inline `style` props this codebase uses pervasively for theming.
   * Script execution is the thing worth protecting.
   */
  /**
   * The Content-Security-Policy lives in proxy.ts, not here.
   *
   * It used to live here, with `script-src 'self'` and no nonce. That policy
   * blocks every inline script, and Next.js ships its React bootstrap and the
   * RSC flight data as inline scripts: the served HTML contains ten of them.
   * With them blocked the page never hydrates, React throws
   * "Minified React error #412", and every route is left showing the loading.tsx
   * fallback forever. curl was immune because CSP is a browser instruction, which
   * is why every server-side check passed while the app was unusable.
   *
   * Two of these headers would also be enforced together, so leaving a copy here
   * would keep the old, nonce-less policy alive and block the fix.
   */
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-DNS-Prefetch-Control", value: "on" },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
          {
            key: "Permissions-Policy",
            // The app reads no camera, microphone, geolocation or payment prompt.
            value: "camera=(), microphone=(), geolocation=(), payment=(), interest-cohort=()",
          },
        ],
      },
    ];
  },
  // The API's billing-portal session returns customers to `/app/billing`
  // (billing.controller.ts builds `${BETTER_AUTH_URL}/app/billing`), a path this
  // app never had. Until the API sends `/billing`, a paying customer coming
  // back from the provider lands on the real page instead of a 404. Temporary
  // (307), so nothing caches it once the API is fixed.
  async redirects() {
    return [
      { source: "/app/billing", destination: "/billing", permanent: false },
      { source: "/app/billing/:path*", destination: "/billing", permanent: false },
    ];
  },
  // Browser-side calls (better-auth sign-in, sign-out) hit the same origin and are
  // proxied to the API, so the session cookie stays first-party and no CORS
  // dance is needed. Server components call the API directly (lib/api.ts).
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${API_BASE}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
