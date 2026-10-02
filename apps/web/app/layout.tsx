import type { Metadata } from "next";
import { Inter } from "next/font/google";
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
    "DMARC email-authentication monitoring for MSPs and IT agencies. Measurement and evidence — never control.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={inter.variable}>
      <body>{children}</body>
    </html>
  );
}
