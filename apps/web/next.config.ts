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

const nextConfig: NextConfig = {
  reactStrictMode: true,
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
  async headers() {
    const csp = [
      "default-src 'self'",
      // 'unsafe-inline' for styles only. See above.
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      // This build serves its own domain and every agency's custom domain from the
      // same output, so connect-src cannot be pinned to one origin.
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      // An auditor may open a compliance verifier link; nothing else may frame us.
      "frame-src 'self'",
      "frame-ancestors 'none'",
      "upgrade-insecure-requests",
    ].join("; ");

    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
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
