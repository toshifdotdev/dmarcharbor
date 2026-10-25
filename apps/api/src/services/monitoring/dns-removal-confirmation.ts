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

const removalCodes = new Set(['dmarc_record_removed', 'dmarc_rua_ours_removed', 'spf_record_removed']);

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
  for (const removal of removals) {
    if (removal.code === 'spf_record_removed') {
      affected.add(input.domainName);
    } else {
      affected.add(`_dmarc.${input.domainName}`);
    }
  }

  await delay(input.waitMs ?? 2_000);

  for (const name of affected) {
    const lookup = await input.reader.resolveTxt(name);
    // Anything other than a missing answer means the removal is not proven.
    // An error is unknown, and unknown is never a reason to alarm a customer.
    if (lookup.status !== 'missing') {
      return { confirmed: false, affected: [...affected] };
    }
  }

  return { confirmed: true, affected: [...affected] };
}
