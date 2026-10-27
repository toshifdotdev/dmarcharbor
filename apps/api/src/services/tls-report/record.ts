/**
 * The one place that turns a domain and our reporting address into the
 * TLS-RPT record. The onboarding step, the TLS tab and the scan guidance all
 * use the same text, so they cannot disagree about what to publish.
 */

import { prisma } from '../../database/prisma.js';
import type { TlsRptResult } from '../../scanner/types.js';
import { clientTlsReportAddress, normaliseReportUri } from '../report-address.service.js';

export type TlsRecordStatus = 'missing' | 'ours' | 'other' | 'invalid' | 'unknown';

export interface TlsRecordView {
  status: TlsRecordStatus;
  host: string;
  current: string | null;
  suggested: string;
}

export function tlsRptRecordFor(_domain: string, address: string): string {
  return `v=TLSRPTv1; rua=mailto:${address}`;
}

function ourUri(address: string): string {
  return `mailto:${address.toLowerCase()}`;
}

function sameUri(left: string, right: string): boolean {
  return normaliseReportUri(left) === normaliseReportUri(right);
}

function dedupeUris(uris: string[]): string[] {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const uri of uris) {
    const key = normaliseReportUri(uri) ?? uri.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    kept.push(uri.trim());
  }
  return kept;
}

/** A clean record from the valid URIs plus ours. */
export function cleanTlsRptRecord(uris: string[], address: string): string {
  const all = dedupeUris([...uris, ourUri(address)]);
  return `v=TLSRPTv1; rua=${all.join(',')}`;
}

/** Append our address to a valid record's rua list, keeping every other tag. */
export function appendTlsRptAddress(record: string, address: string): string {
  const ours = ourUri(address);
  if (record.includes(ours)) {
    return record;
  }
  const tags = record.split(';').map((tag) => tag.trim()).filter(Boolean);
  let found = false;
  const updated = tags.map((tag) => {
    const equals = tag.indexOf('=');
    if (equals < 0 || tag.slice(0, equals).trim().toLowerCase() !== 'rua') {
      return tag;
    }
    found = true;
    const existing = tag
      .slice(equals + 1)
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    if (existing.some((uri) => sameUri(uri, ours))) {
      return tag;
    }
    return `rua=${[...existing, ours].join(',')}`;
  });
  if (!found) {
    updated.push(`rua=${ours}`);
  }
  return updated.join('; ');
}

function tlsResult(result: unknown): TlsRptResult | null {
  if (!result || typeof result !== 'object') return null;
  const tls = (result as { tlsRpt?: TlsRptResult }).tlsRpt;
  return tls && typeof tls === 'object' ? tls : null;
}

/** The record state for the latest completed scan, and what to publish. */
export async function tlsRecordForDomain(
  domainId: string,
  domainName: string,
  reportToken: string,
): Promise<TlsRecordView> {
  const address = clientTlsReportAddress(reportToken);
  const host = `_smtp._tls.${domainName}`;
  const suggested = tlsRptRecordFor(domainName, address);
  const scan = await prisma.scan.findFirst({
    where: { domainId, status: 'COMPLETED' },
    orderBy: { startedAt: 'desc' },
    select: { result: true },
  });
  const tls = tlsResult(scan?.result);
  if (!tls || tls.status === 'error') {
    return { status: 'unknown', host, current: null, suggested };
  }
  const current = tls.record ?? null;
  if (tls.status === 'missing') {
    return { status: 'missing', host, current, suggested };
  }
  if (!tls.valid) {
    return {
      status: 'invalid',
      host,
      current,
      suggested: cleanTlsRptRecord([...tls.mailtoTargets, ...tls.httpsTargets], address),
    };
  }
  const hasOurs = tls.mailtoTargets.some((uri) => sameUri(uri, ourUri(address)));
  if (hasOurs) {
    return { status: 'ours', host, current, suggested: current ?? suggested };
  }
  return {
    status: 'other',
    host,
    current,
    suggested: current ? appendTlsRptAddress(current, address) : suggested,
  };
}
