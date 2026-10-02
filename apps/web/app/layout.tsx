import type { Metadata } from "next";
import "./globals.css";

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
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
