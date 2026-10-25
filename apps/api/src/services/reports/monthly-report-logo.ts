import { lookup as dnsLookup } from 'node:dns/promises';
import { objectKeyFromLogoUrl, readStoredLogoBytes } from '../branding/logo-storage.service.js';
import { assertPublicHost, isPrivateOrReservedHost } from '../net-guard.js';

/**
 * Logo bytes for the monthly report.
 *
 * The report is a client-facing document, so a broken logo must never make it
 * fail. Everything here returns null on any problem, and the document simply
 * renders without one.
 *
 * Only PNG and JPEG are embeddable by the PDF library without throwing at
 * render time. SVG is a program rather than a picture, and WebP is not a
 * format the PDF renderer understands; both are refused by looking at the
 * magic bytes, not at a Content-Type header a remote server chose.
 */

export const maxMonthlyReportLogoBytes = 512 * 1024;

export interface ReportLogo {
  bytes: Buffer;
  contentType: 'image/png' | 'image/jpeg';
}

/** Reads the file's own signature. A declared type is a claim, not evidence. */
export function inspectReportLogo(bytes: Buffer): ReportLogo | null {
  if (bytes.length === 0 || bytes.length > maxMonthlyReportLogoBytes) {
    return null;
  }

  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return { bytes, contentType: 'image/png' };
  }

  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { bytes, contentType: 'image/jpeg' };
  }

  return null;
}

interface LogoDependencies {
  fetchImpl?: typeof fetch;
  lookup?: (hostname: string) => Promise<Array<{ address: string }>>;
}

async function defaultLookup(hostname: string): Promise<Array<{ address: string }>> {
  return dnsLookup(hostname, { all: true, verbatim: true });
}

export async function loadMonthlyReportLogo(
  logoUrl: string | null | undefined,
  dependencies: LogoDependencies = {},
): Promise<ReportLogo | null> {
  if (!logoUrl) {
    return null;
  }

  // A logo this deployment stored is read from storage by key. Fetching our
  // own public URL would add a network hop and a cache dependency to every
  // report for a file we already hold.
  const key = objectKeyFromLogoUrl(logoUrl);
  if (key) {
    const bytes = await readStoredLogoBytes(key, maxMonthlyReportLogoBytes);
    return bytes ? inspectReportLogo(bytes) : null;
  }

  let parsed: URL;
  try {
    parsed = new URL(logoUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || !parsed.hostname) {
    return null;
  }

  // The shared guard waives loopback outside production so the webhook and
  // mailbox test receivers can listen on 127.0.0.1. A logo never has that
  // reason: the report renderer must refuse loopback, private and link-local
  // answers in every environment, including the one that runs these tests.
  if (isPrivateOrReservedHost(parsed.hostname)) {
    return null;
  }

  try {
    const addresses = await assertPublicHost(parsed.hostname, dependencies.lookup ?? defaultLookup);
    if (addresses.some((entry) => isPrivateOrReservedHost(entry.address.replace(/^\[|\]$/g, '')))) {
      return null;
    }
  } catch {
    return null;
  }

  const fetchImpl = dependencies.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(parsed.toString(), {
      // Following a redirect would let a public host hand the connection to a
      // private one after the address check had already passed.
      redirect: 'error',
      signal: AbortSignal.timeout(5_000),
      headers: { accept: 'image/png,image/jpeg' },
    });
    if (!response.ok) {
      return null;
    }

    const declaredLength = Number(response.headers.get('content-length') ?? '');
    if (Number.isFinite(declaredLength) && declaredLength > maxMonthlyReportLogoBytes) {
      return null;
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    return inspectReportLogo(bytes);
  } catch {
    return null;
  }
}
