/**
 * domain-routes.ts — which line each measured sender is drawn on.
 *
 * Pure and server-safe (no "use client"): the domain page calls it on the
 * server to build the map's data, and the senders table calls it in the
 * browser to draw the same colour beside each row, so a sender is the same
 * colour in the map and in the table.
 *
 * The rules:
 * - One line per sender the API reports, keyed by the domain it authenticated
 *   as. Nothing is invented: a sender with no messages is not drawn.
 * - A sender whose every message failed DMARC is the forged line: dashed red,
 *   drawn last, turned away. Red is never used for anything else.
 * - The other senders take the five line colours. A sender keeps its colour
 *   from one visit to the next (it is chosen from a hash of the service, or of
 *   the sender, and only moves on when two senders on one domain want the
 *   same one), so the orange line is still HubSpot tomorrow.
 * - Past five senders, the smallest are merged into one grey line, labelled
 *   with how many it carries. Their figures are summed, never estimated.
 */

import type { SenderRow } from "@/lib/types";

export const ROUTE_COLOURS = [
  "var(--color-route-blue)",
  "var(--color-route-orange)",
  "var(--color-route-green)",
  "var(--color-route-yellow)",
  "var(--color-route-purple)",
] as const;
export const MERGED_COLOUR = "var(--color-fg-4)";
export const FORGED_COLOUR = "var(--color-route-red)";

const MAX_LINES = ROUTE_COLOURS.length;

export interface RouteLine {
  key: string;
  /** Bold half of the label: a service name, or the domain it signed as. */
  name: string;
  /** The name is an identifier (a domain), set in the data face. */
  mono: boolean;
  /** The lighter half of the label. */
  kind: string;
  colour: string;
  total: number;
  /** Failed DMARC: both aligned checks failed. */
  failed: number;
  /** Messages that passed aligned SPF, and aligned DKIM, as the reports say. */
  spfPass: number;
  dkimPass: number;
  /** Every message on this line failed DMARC. */
  forged: boolean;
  /** How many senders this line carries (more than one only when merged). */
  senders: number;
  sources: number;
}

export interface RouteSwatch {
  colour: string;
  forged: boolean;
}

const KIND: Record<string, string> = {
  mailbox: "staff mail",
  transactional: "app mail",
  marketing: "marketing",
  crm: "CRM",
  support: "helpdesk",
  security: "mail filter",
  other: "service",
};

function hash(text: string): number {
  // FNV-1a, 32 bit: stable across server and browser.
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function named(row: SenderRow): boolean {
  return Boolean(row.service && (row.confidence === "confirmed" || row.confidence === "likely"));
}

function label(row: SenderRow, domainName: string): { name: string; mono: boolean; kind: string } {
  const signedAs = (row.senderDomain ?? "").toLowerCase();
  const elsewhere = signedAs !== "" && signedAs !== domainName.toLowerCase();
  if (named(row) && row.service) {
    return {
      name: row.service.name,
      mono: false,
      kind: elsewhere ? `${KIND[row.service.category] ?? "service"}, signs as another domain` : (KIND[row.service.category] ?? "service"),
    };
  }
  const kind =
    row.confidence === "own"
      ? "your own server"
      : row.confidence === "network"
        ? row.network?.asnName
          ? `network ${row.network.asnName}`
          : "network only"
        : "not identified";
  return {
    name: row.senderDomain ?? row.senderKey,
    mono: true,
    kind: elsewhere ? `${kind}, not this domain` : kind,
  };
}

function isForged(row: SenderRow): boolean {
  return row.totalMessages > 0 && row.dmarcFailedMessages >= row.totalMessages;
}

/**
 * The lines to draw, top to bottom (largest sender first, the forged line
 * last), and the colour each sender was given.
 */
export function routeLines(
  senders: SenderRow[],
  domainName: string,
): { lines: RouteLine[]; swatches: Record<string, RouteSwatch> } {
  const measured = senders.filter((row) => row.totalMessages > 0);
  const byVolume = (a: SenderRow, b: SenderRow) =>
    b.totalMessages - a.totalMessages || a.senderKey.localeCompare(b.senderKey);
  const honest = measured.filter((row) => !isForged(row)).sort(byVolume);
  const forged = measured
    .filter(isForged)
    .sort((a, b) => b.dmarcFailedMessages - a.dmarcFailedMessages || a.senderKey.localeCompare(b.senderKey));

  const own = honest.length > MAX_LINES ? honest.slice(0, MAX_LINES - 1) : honest;
  const rest = honest.length > MAX_LINES ? honest.slice(MAX_LINES - 1) : [];

  const taken = new Set<number>();
  const swatches: Record<string, RouteSwatch> = {};
  const lines: RouteLine[] = own.map((row) => {
    let slot = hash(row.service && named(row) ? `service:${row.service.id}` : `sender:${row.senderKey}`) % ROUTE_COLOURS.length;
    while (taken.has(slot)) slot = (slot + 1) % ROUTE_COLOURS.length;
    taken.add(slot);
    const colour = ROUTE_COLOURS[slot];
    swatches[row.senderKey] = { colour, forged: false };
    return {
      key: row.senderKey,
      ...label(row, domainName),
      colour,
      total: row.totalMessages,
      failed: row.dmarcFailedMessages,
      spfPass: row.spfPassMessages,
      dkimPass: row.dkimPassMessages,
      forged: false,
      senders: 1,
      sources: row.sourceIps.length,
    };
  });

  if (rest.length > 0) {
    for (const row of rest) swatches[row.senderKey] = { colour: MERGED_COLOUR, forged: false };
    lines.push({
      key: "merged",
      name: `${rest.length} more senders`,
      mono: false,
      kind: "smaller, on one line",
      colour: MERGED_COLOUR,
      total: rest.reduce((n, row) => n + row.totalMessages, 0),
      failed: rest.reduce((n, row) => n + row.dmarcFailedMessages, 0),
      spfPass: rest.reduce((n, row) => n + row.spfPassMessages, 0),
      dkimPass: rest.reduce((n, row) => n + row.dkimPassMessages, 0),
      forged: false,
      senders: rest.length,
      sources: new Set(rest.flatMap((row) => row.sourceIps)).size,
    });
  }

  if (forged.length > 0) {
    for (const row of forged) swatches[row.senderKey] = { colour: FORGED_COLOUR, forged: true };
    const one = forged.length === 1 ? forged[0] : null;
    lines.push({
      key: "forged",
      ...(one ? label(one, domainName) : { name: `${forged.length} senders`, mono: false, kind: "every message failed" }),
      colour: FORGED_COLOUR,
      total: forged.reduce((n, row) => n + row.totalMessages, 0),
      failed: forged.reduce((n, row) => n + row.dmarcFailedMessages, 0),
      spfPass: forged.reduce((n, row) => n + row.spfPassMessages, 0),
      dkimPass: forged.reduce((n, row) => n + row.dkimPassMessages, 0),
      forged: true,
      senders: forged.length,
      sources: new Set(forged.flatMap((row) => row.sourceIps)).size,
    });
  }

  return { lines, swatches };
}

/**
 * A share as a percentage, never rounded up to a pass: 98.75 reads 98.7%, and
 * 99.96 reads 99.9%, because "100%" must mean every message.
 */
export function passPercent(value: number | null): string {
  if (value === null || Number.isNaN(value)) return "not measured";
  if (value >= 100) return "100%";
  if (value <= 0) return "0%";
  return `${(Math.floor(value * 10 + 1e-9) / 10).toFixed(1)}%`;
}
