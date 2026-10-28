import { lookup as dnsLookup } from 'node:dns/promises';
import { objectKeyFromLogoUrl, readStoredLogoBytes } from '../branding/logo-storage.service.js';
import { assertPublicHost, isPrivateOrReservedHost } from '../net-guard.js';
import { createGuardedRequester, type GuardedRequester } from '../net/guarded-request.js';

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
  /** The pinned requester; tests pass a fake so nothing reaches the network. */
  request?: GuardedRequester;
  lookup?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
}

async function defaultLookup(hostname: string): Promise<Array<{ address: string; family: number }>> {
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

  /**
   * Fetched through the pinned requester, which resolves the name again,
   * re-checks every answer and opens the socket to exactly the address it
   * checked. This used global `fetch`, which resolves the name on its own at
   * connect time, so a rebinding host could pass the check above as a public
   * address and then serve the request from a private one.
   *
   * Redirects are refused (a public host must not hand the connection on), and
   * the cap is the logo limit, so an oversized answer is never buffered.
   */
  const request =
    dependencies.request ?? createGuardedRequester({ lookup: dependencies.lookup ?? defaultLookup });
  try {
    const response = await request({
      url: parsed.toString(),
      method: 'GET',
      policy: 'strict',
      headers: { accept: 'image/png,image/jpeg' },
      maxBytes: maxMonthlyReportLogoBytes,
      timeoutMs: 5_000,
    });
    if (response.status !== 'ok' || response.statusCode < 200 || response.statusCode >= 300) {
      return null;
    }
    return inspectReportLogo(response.body);
  } catch {
    return null;
  }
}
