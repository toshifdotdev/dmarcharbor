import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { BrandApplier } from "@/components/brand-applier";
import "./globals.css";

/**
 * Inter is the product's UI face: a professional grotesque built for screens,
 * with true tabular figures so number columns scan vertically. Display
 * headings use the same family at heavier weight — one voice across the app.
 */
const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-inter",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "DMARC Harbor",
    template: "%s · DMARC Harbor",
  },
  description:
    "DMARC email-authentication monitoring for MSPs and IT agencies. Measurement and evidence: never control.",
};

// Every route in this app renders per request: the session cookie picks the
// workspace and the custom-Host header picks the brand. There is nothing to
// prerender, and forcing that is what made Next's synthetic error pages crash
// (the root layout's headers() has no request store in a static export).
export const dynamic = "force-dynamic";

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={inter.variable}>
      {/* On a custom domain this is the agency's palette replacing ours at the
          token level — every screen, not just the chrome. Nothing renders
          unless the record is verified. */}
      <BrandApplier />
      <body>{children}</body>
    </html>
  );
}
