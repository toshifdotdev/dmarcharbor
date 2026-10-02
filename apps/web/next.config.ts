import type { NextConfig } from "next";

const API_BASE = process.env.API_BASE_URL ?? "http://localhost:4000";

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
