import { isIP } from 'node:net';
import type { IpIntelStatus } from '@prisma/client';
import { prisma } from '../../database/prisma.js';
import { env } from '../../config/env.js';
import { systemDnsReader } from '../../scanner/dns.js';
import type { DnsReader } from '../../scanner/types.js';
import { isPrivateOrReservedHost } from '../net-guard.js';
import { cleanText } from './sanitize.js';

/**
 * Public network facts for sending IPs.
 *
 * DNS only: reverse DNS and Team Cymru's free ASN service. No HTTP, no new
 * dependency, and no lookup for an address that is not on the public internet.
 * These rows describe infrastructure, not a tenant, and are shared by every
 * workspace that sees the same address.
 */

const successfulLifetimeDays = 30;
const failedLifetimeDays = 1;
const privateLifetimeDays = 30;
const claimMinutes = 5;

export interface IpIntelResult {
  ip: string;
  ptr: string | null;
  ptrConfirmed: boolean;
  asn: number | null;
  asnName: string | null;
  status: IpIntelStatus;
  lookedUpAt: Date;
  expiresAt: Date;
  lastSeenAt: Date;
}

/** Lowercase, and canonical compressed IPv6 through the URL parser. */
export function normaliseIpAddress(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  const family = isIP(trimmed);
  if (family === 4) {
    return trimmed;
  }
  if (family !== 6) {
    return null;
  }

  try {
    return new URL(`http://[${trimmed}]/`).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return null;
  }
}

function ipv4Octets(ip: string): [number, number, number, number] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!match) return null;
  const octets = match.slice(1).map(Number);
  return octets.every((octet) => octet <= 255) ? (octets as [number, number, number, number]) : null;
}

/**
 * Public addresses only. `isPrivateOrReservedHost` covers loopback, RFC1918,
 * CGNAT and link-local; documentation, benchmarking, multicast and the
 * reserved blocks are added here because a report can legitimately contain
 * them and none of them is a sending service we can name.
 */
export function isNonPublicIp(ip: string): boolean {
  if (isPrivateOrReservedHost(ip)) {
    return true;
  }

  const v4 = ipv4Octets(ip);
  if (v4) {
    const [a, b] = v4;
    return (
      (a === 192 && b === 0) ||
      (a === 192 && b === 2) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && v4[2] === 100) ||
      (a === 203 && b === 0 && v4[2] === 113) ||
      a >= 224 ||
      (a === 255 && b === 255)
    );
  }

  const v6 = ip.toLowerCase();
  return (
    v6 === '::' ||
    v6 === '::1' ||
    v6.startsWith('2001:db8:') ||
    v6 === '2001:db8::' ||
    v6.startsWith('2001:2:') ||
    v6 === '2001:2::' ||
    v6.startsWith('100:') ||
    v6.startsWith('ff')
  );
}

function expandIpv6(ip: string): string[] | null {
  const [head, tail] = ip.split('::');
  const headGroups = head ? head.split(':').filter(Boolean) : [];
  const tailGroups = tail ? tail.split(':').filter(Boolean) : [];
  const missing = ip.includes('::') ? 8 - headGroups.length - tailGroups.length : 0;
  if (missing < 0) return null;
  const groups = [...headGroups, ...Array.from({ length: missing }, () => '0'), ...tailGroups];
  return groups.length === 8 ? groups.map((group) => group.padStart(4, '0')) : null;
}

/** The Team Cymru origin-asn name, with IPv4 octets or IPv6 nibbles reversed. */
export function cymruOriginQuery(ip: string): string | null {
  const normalised = normaliseIpAddress(ip);
  if (!normalised) return null;

  if (isIP(normalised) === 4) {
    return `${normalised.split('.').reverse().join('.')}.origin.asn.cymru.com`;
  }

  const groups = expandIpv6(normalised);
  if (!groups) return null;
  const nibbles = groups.join('').split('').reverse().join('.');
  return `${nibbles}.origin6.asn.cymru.com`;
}

/** `15169 | 8.8.8.0/24 | US | arin | 2023-12-28`, first ASN when several. */
export function parseCymruOrigin(value: string): number | null {
  const field = value.split('|')[0]?.trim() ?? '';
  const first = field.split(/\s+/)[0] ?? '';
  if (!/^\d{1,10}$/.test(first)) {
    return null;
  }
  const asn = Number(first);
  return Number.isInteger(asn) && asn > 0 ? asn : null;
}

/** `15169 | US | arin | 2000-03-30 | GOOGLE, US`, the trailing name. */
export function parseCymruAsnName(value: string): string | null {
  const fields = value.split('|');
  if (fields.length < 5) return null;
  const name = cleanDnsText(fields[fields.length - 1] ?? '', 120);
  return name || null;
}

/** DNS text is untrusted: strip controls and cap the length before storing. */
export function cleanDnsText(value: string, maxLength: number): string {
  return cleanText(value, maxLength);
}

function ptrName(value: string): string | null {
  const clean = cleanDnsText(value, 253).toLowerCase().replace(/\.+$/, '');
  return clean || null;
}

async function reverseDns(
  ip: string,
  reader: DnsReader,
): Promise<{ ptr: string | null; ptrConfirmed: boolean }> {
  if (!reader.resolvePtr) {
    return { ptr: null, ptrConfirmed: false };
  }

  const lookup = await reader.resolvePtr(ip);
  if (lookup.status !== 'found' || !lookup.value?.[0]) {
    return { ptr: null, ptrConfirmed: false };
  }

  const ptr = ptrName(lookup.value[0]);
  if (!ptr) {
    return { ptr: null, ptrConfirmed: false };
  }

  if (!reader.resolveAddress) {
    return { ptr, ptrConfirmed: false };
  }

  const answer = await reader.resolveAddress(ptr);
  if (answer.status !== 'found' || !answer.value) {
    return { ptr, ptrConfirmed: false };
  }

  const confirmed = answer.value.some((address) => normaliseIpAddress(address) === ip);
  return { ptr, ptrConfirmed: confirmed };
}

async function asnFacts(
  ip: string,
  reader: DnsReader,
): Promise<{ asn: number | null; asnName: string | null }> {
  const query = cymruOriginQuery(ip);
  if (!query) {
    return { asn: null, asnName: null };
  }

  const origin = await reader.resolveTxt(query);
  if (origin.status !== 'found' || !origin.value?.[0]) {
    return { asn: null, asnName: null };
  }

  const asn = parseCymruOrigin(origin.value[0].join(''));
  if (asn === null) {
    return { asn: null, asnName: null };
  }

  const nameLookup = await reader.resolveTxt(`AS${asn}.asn.cymru.com`);
  const asnName =
    nameLookup.status === 'found' && nameLookup.value?.[0]
      ? parseCymruAsnName(nameLookup.value[0].join(''))
      : null;

  return { asn, asnName };
}

/** Looks one IP up. Private and reserved addresses never reach the resolver. */
export async function lookupIpIntel(
  rawIp: string,
  reader: DnsReader = systemDnsReader,
  now = new Date(),
): Promise<IpIntelResult> {
  const ip = normaliseIpAddress(rawIp);
  if (!ip) {
    return {
      ip: rawIp.trim().toLowerCase(),
      ptr: null,
      ptrConfirmed: false,
      asn: null,
      asnName: null,
      status: 'FAILED',
      lookedUpAt: now,
      expiresAt: new Date(now.getTime() + failedLifetimeDays * 24 * 60 * 60 * 1000),
      lastSeenAt: now,
    };
  }

  if (isNonPublicIp(ip)) {
    return {
      ip,
      ptr: null,
      ptrConfirmed: false,
      asn: null,
      asnName: null,
      status: 'PRIVATE',
      lookedUpAt: now,
      expiresAt: new Date(now.getTime() + privateLifetimeDays * 24 * 60 * 60 * 1000),
      lastSeenAt: now,
    };
  }

  const reverse = await reverseDns(ip, reader);
  const asn = await asnFacts(ip, reader);

  const status: IpIntelStatus =
    asn.asn !== null && reverse.ptrConfirmed
      ? 'OK'
      : asn.asn !== null || reverse.ptrConfirmed || reverse.ptr
        ? 'PARTIAL'
        : 'FAILED';
  const lifetimeDays = status === 'FAILED' ? failedLifetimeDays : successfulLifetimeDays;

  return {
    ip,
    ptr: reverse.ptr,
    ptrConfirmed: reverse.ptrConfirmed,
    asn: asn.asn,
    asnName: asn.asnName,
    status,
    lookedUpAt: now,
    expiresAt: new Date(now.getTime() + lifetimeDays * 24 * 60 * 60 * 1000),
    lastSeenAt: now,
  };
}

interface CandidateRow {
  ip: string;
  lastSeen: Date;
}

export interface SenderIntelRunResult {
  examined: number;
  lookedUp: number;
  ok: number;
  partial: number;
  failed: number;
  private: number;
  skipped: number;
}

/**
 * Looks up the least recently resolved public IPs seen in the last 30 days.
 *
 * A placeholder row is claimed before the resolver is touched, so two
 * instances looking at the same backlog perform each lookup once. The
 * placeholder expires after five minutes, which is what lets a crashed worker
 * be retried without a manual clean-up.
 */
export async function runSenderIntelPass(
  now = new Date(),
  reader: DnsReader = systemDnsReader,
): Promise<SenderIntelRunResult> {
  const since = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const candidates = await prisma.$queryRaw<CandidateRow[]>`
    SELECT rec."sourceIp" AS ip, MAX(r."receivedAt") AS "lastSeen"
    FROM "dmarc_report_record" rec
    JOIN "dmarc_report" r ON r.id = rec."reportId"
    WHERE r."receivedAt" >= ${since}
      AND NOT EXISTS (
        SELECT 1 FROM "source_ip_intel" i
        WHERE i.ip = rec."sourceIp" AND i."expiresAt" > ${now}
      )
    GROUP BY rec."sourceIp"
    ORDER BY MAX(r."receivedAt") DESC
    LIMIT ${env.SENDER_INTEL_BATCH}
  `;

  const seen = await prisma.$queryRaw<CandidateRow[]>`
    SELECT rec."sourceIp" AS ip, MAX(r."receivedAt") AS "lastSeen"
    FROM "dmarc_report_record" rec
    JOIN "dmarc_report" r ON r.id = rec."reportId"
    WHERE r."receivedAt" >= ${since}
    GROUP BY rec."sourceIp"
    LIMIT ${Math.max(env.SENDER_INTEL_BATCH * 4, 500)}
  `;

  const seenIps = [...new Set(seen.map((row) => normaliseIpAddress(row.ip)).filter((ip): ip is string => Boolean(ip)))];
  if (seenIps.length > 0) {
    await prisma.sourceIpIntel.updateMany({
      where: { ip: { in: seenIps }, expiresAt: { gt: now } },
      data: { lastSeenAt: now },
    });
  }

  const unique = new Map<string, CandidateRow>();
  for (const row of candidates) {
    const ip = normaliseIpAddress(row.ip);
    if (ip && !unique.has(ip)) {
      unique.set(ip, row);
    }
  }

  const claimed: CandidateRow[] = [];
  for (const row of unique.values()) {
    const ip = normaliseIpAddress(row.ip);
    if (!ip) continue;

    const existing = await prisma.sourceIpIntel.updateMany({
      where: { ip, expiresAt: { lte: now } },
      data: { status: 'PARTIAL', lookedUpAt: now, expiresAt: new Date(now.getTime() + claimMinutes * 60_000), lastSeenAt: now },
    });
    if (existing.count === 1) {
      claimed.push({ ip, lastSeen: row.lastSeen });
      continue;
    }

    const created = await prisma.sourceIpIntel.createMany({
      data: [{
        ip,
        status: 'PARTIAL',
        lookedUpAt: now,
        expiresAt: new Date(now.getTime() + claimMinutes * 60_000),
        lastSeenAt: now,
      }],
      skipDuplicates: true,
    });
    if (created.count === 1) {
      claimed.push({ ip, lastSeen: row.lastSeen });
    }
  }

  const result: SenderIntelRunResult = {
    examined: unique.size,
    lookedUp: 0,
    ok: 0,
    partial: 0,
    failed: 0,
    private: 0,
    skipped: unique.size - claimed.length,
  };

  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      const candidate = claimed[index];
      if (!candidate) return;

      try {
        const intel = await lookupIpIntel(candidate.ip, reader, now);
        await prisma.sourceIpIntel.update({
          where: { ip: candidate.ip },
          data: {
            ptr: intel.ptr,
            ptrConfirmed: intel.ptrConfirmed,
            asn: intel.asn,
            asnName: intel.asnName,
            status: intel.status,
            lookedUpAt: intel.lookedUpAt,
            expiresAt: intel.expiresAt,
            lastSeenAt: intel.lastSeenAt,
          },
        });
        result.lookedUp += 1;
        if (intel.status === 'OK') result.ok += 1;
        else if (intel.status === 'PARTIAL') result.partial += 1;
        else if (intel.status === 'PRIVATE') result.private += 1;
        else result.failed += 1;
      } catch (error) {
        console.error(
          `[sender-intel] ${candidate.ip} failed: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
        await prisma.sourceIpIntel
          .update({
            where: { ip: candidate.ip },
            data: {
              status: 'FAILED',
              lookedUpAt: now,
              expiresAt: new Date(now.getTime() + failedLifetimeDays * 24 * 60 * 60 * 1000),
              lastSeenAt: now,
            },
          })
          .catch(() => undefined);
        result.lookedUp += 1;
        result.failed += 1;
      }
    }
  };

  await Promise.all(Array.from({ length: 5 }, () => worker()));
  return result;
}
