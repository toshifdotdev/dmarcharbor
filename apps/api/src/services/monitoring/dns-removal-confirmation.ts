import type { DnsReader, ScanResult } from '../../scanner/types.js';
import { diffScans } from './dns-diff.js';

/**
 * DNS answers inconsistently often enough that a single "missing" is not proof
 * of a removal.
 *
 * Before a critical removal is stored, the one affected name is read again
 * after a short pause. A record that is still missing confirms the change; a
 * record that reappears, or a lookup that errors, does not, and the caller
 * records the scan as failed rather than telling a customer their DMARC or SPF
 * record was removed when it was not.
 */
export interface RemovalConfirmation {
  confirmed: boolean;
  /** The names that were re-read, for the failure message and for tests. */
  affected: string[];
}

const removalCodes = new Set([
  'dmarc_record_removed',
  'dmarc_rua_ours_removed',
  'spf_record_removed',
  'mta_sts_removed',
  'tls_rpt_removed',
  'bimi_removed',
]);

const transportRemovals: Record<
  string,
  { name: (domain: string) => string; prefix: string }
> = {
  mta_sts_removed: { name: (domain) => `_mta-sts.${domain}`, prefix: 'v=STSv1' },
  tls_rpt_removed: { name: (domain) => `_smtp._tls.${domain}`, prefix: 'v=TLSRPTv1' },
  bimi_removed: { name: (domain) => `default._bimi.${domain}`, prefix: 'v=BIMI1' },
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function confirmDnsRemovals(input: {
  domainName: string;
  previous: ScanResult;
  current: ScanResult;
  reader: DnsReader;
  /** Tests pass 0; production uses the two second pause. */
  waitMs?: number;
}): Promise<RemovalConfirmation> {
  const drafts = diffScans(input.previous, input.current);
  const removals = drafts.filter((draft) => removalCodes.has(draft.code));

  if (removals.length === 0) {
    return { confirmed: true, affected: [] };
  }

  const affected = new Set<string>();
  const checks: Array<{ name: string; prefix: string | null }> = [];
  for (const removal of removals) {
    const transport = transportRemovals[removal.code];
    if (transport) {
      const name = transport.name(input.domainName);
      affected.add(name);
      checks.push({ name, prefix: transport.prefix });
    } else if (removal.code === 'spf_record_removed') {
      affected.add(input.domainName);
      checks.push({ name: input.domainName, prefix: null });
    } else {
      const name = `_dmarc.${input.domainName}`;
      affected.add(name);
      checks.push({ name, prefix: null });
    }
  }

  await delay(input.waitMs ?? 2_000);

  const toRead = [...new Map(checks.map((check) => [`${check.name}|${check.prefix ?? ''}`, check])).values()];
  for (const check of toRead) {
    const lookup = await input.reader.resolveTxt(check.name);
    // Anything other than a missing answer means the removal is not proven.
    // An error is unknown, and unknown is never a reason to alarm a customer.
    if (lookup.status === 'missing') {
      continue;
    }
    if (check.prefix && lookup.status === 'found') {
      const stillPublished = (lookup.value ?? []).some((chunks) =>
        chunks.join('').trim().startsWith(check.prefix!),
      );
      // An unrelated TXT left at the name is not evidence the record survived.
      if (!stillPublished) {
        continue;
      }
    }
    return { confirmed: false, affected: [...affected] };
  }

  return { confirmed: true, affected: [...affected] };
}
