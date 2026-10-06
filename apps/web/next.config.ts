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
  // Browser-side calls (better-auth sign-in, sign-out) hit the same origin and
  // are proxied to the API, so the session cookie stays first-party and no CORS
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
