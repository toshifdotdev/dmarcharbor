import { normaliseForAlignment, organizationalDomain } from '../alignment.service.js';
import { cleanText } from './sanitize.js';
import {
  entriesForAsn,
  entriesForDomain,
  entriesForPtr,
  type CatalogueEntry,
  type ServiceCategory,
} from './service-catalogue.js';

/**
 * Naming a sending service from evidence.
 *
 * Pure: no database and no DNS. A name is only produced when a whole-label
 * signal supports it, and the confidence says what the signal was:
 *
 * confirmed  a passing aligned DKIM d= or SPF domain matches the catalogue
 * likely     a confirmed PTR matches, optionally corroborated by the ASN or by
 *            a failing DKIM/SPF domain for the same service. A failing
 *            domain on its own is what the sender claimed, not evidence, so
 *            it never names a service: a spoofer could otherwise label
 *            itself "Google Workspace" and invite an approval.
 * network    only the ASN is known; no service name is invented
 * own        a confirmed PTR belongs to the domain being reported on
 * unknown    nothing matched
 *
 * An ASN alone never names a service. An unconfirmed PTR is stored by the
 * cache but is not evidence here.
 */

export type SenderConfidence = 'confirmed' | 'likely' | 'network' | 'own' | 'unknown';

export interface SenderService {
  id: string;
  name: string;
  category: ServiceCategory;
}

export interface SenderNetwork {
  asn: number;
  asnName: string | null;
}

export interface AuthSignal {
  type: string;
  domain: string | null;
  result: string;
  messageCount: number;
}

export interface CachedIntel {
  ip: string;
  ptr: string | null;
  ptrConfirmed: boolean;
  asn: number | null;
  asnName: string | null;
}

export interface SenderAttribution {
  service: SenderService | null;
  confidence: SenderConfidence;
  network: SenderNetwork | null;
  evidence: string[];
  intelPending: boolean;
}

interface Candidate {
  entry: CatalogueEntry;
  messages: number;
  confirmed: boolean;
  likely: boolean;
  evidence: string[];
  hasSignal: boolean;
  /**
   * Evidence the sender could not have forged: a DKIM or SPF domain that
   * passed, or a forward-confirmed reverse DNS name. A failing DKIM d= or SPF
   * domain is whatever the sender wrote, so a spoofer can claim to be any
   * service. Only a verified candidate may be named, and an ASN may only
   * corroborate a verified one.
   */
  verified: boolean;
}

function clean(value: string, max = 160): string {
  return cleanText(value, max);
}

function isPass(result: string): boolean {
  return result.trim().toLowerCase() === 'pass';
}

function candidateMap(): Map<string, Candidate> {
  return new Map();
}

function addSignal(
  candidates: Map<string, Candidate>,
  entry: CatalogueEntry,
  messages: number,
  confirmed: boolean,
  evidence: string,
  verified = confirmed,
): void {
  const existing = candidates.get(entry.id) ?? {
    entry,
    messages: 0,
    confirmed: false,
    likely: false,
    evidence: [],
    hasSignal: false,
    verified: false,
  };
  existing.messages += messages;
  existing.hasSignal = true;
  if (verified) {
    existing.verified = true;
  }
  if (confirmed) {
    existing.confirmed = true;
  } else {
    existing.likely = true;
  }
  const line = clean(evidence);
  if (line && !existing.evidence.includes(line) && existing.evidence.length < 5) {
    existing.evidence.push(line);
  }
  candidates.set(entry.id, existing);
}

function addEvidence(set: string[], value: string): void {
  const line = clean(value);
  if (line && !set.includes(line) && set.length < 5) {
    set.push(line);
  }
}

function ownServer(ptr: string, reportedDomain: string): boolean {
  const host = normaliseForAlignment(ptr);
  const domain = normaliseForAlignment(reportedDomain);
  if (!host || !domain) return false;
  const org = organizationalDomain(domain);
  return (
    host === domain ||
    host.endsWith(`.${domain}`) ||
    (Boolean(org) && (host === org || host.endsWith(`.${org}`)))
  );
}

function choose(candidates: Map<string, Candidate>): Candidate | null {
  return (
    [...candidates.values()].filter((candidate) => candidate.verified).sort(
      (left, right) =>
        right.messages - left.messages ||
        Number(right.confirmed) - Number(left.confirmed) ||
        left.entry.name.localeCompare(right.entry.name),
    )[0] ?? null
  );
}

export function attributeSender(input: {
  reportedDomain: string;
  signals: AuthSignal[];
  ipMessages: Map<string, number>;
  intel: Map<string, CachedIntel>;
  intelPending: boolean;
}): SenderAttribution {
  const candidates = candidateMap();
  const allEvidence: string[] = [];
  let own = false;
  let network: SenderNetwork | null = null;
  let networkWeight = -1;

  for (const signal of input.signals) {
    const domain = normaliseForAlignment(signal.domain);
    if (!domain) continue;
    const kind = signal.type.toUpperCase() === 'DKIM' ? 'dkim' : 'spf';
    const entries = entriesForDomain(domain, kind);
    for (const entry of entries) {
      const label = kind === 'dkim' ? `DKIM d=${domain}` : `SPF domain=${domain}`;
      addSignal(
        candidates,
        entry,
        signal.messageCount,
        isPass(signal.result),
        `${label} (${signal.result || 'unknown'})`,
      );
      addEvidence(allEvidence, `${label} (${signal.result || 'unknown'})`);
    }
  }

  for (const [ip, messages] of input.ipMessages) {
    const intel = input.intel.get(ip);
    if (!intel) continue;

    if (intel.asn !== null && messages > networkWeight) {
      network = { asn: intel.asn, asnName: intel.asnName };
      networkWeight = messages;
    }

    if (intel.ptrConfirmed && intel.ptr) {
      if (ownServer(intel.ptr, input.reportedDomain)) {
        own = true;
        addEvidence(allEvidence, `Reverse DNS ${intel.ptr} (confirmed)`);
      }

      const ptrEntries = entriesForPtr(intel.ptr);
      const ptrMatched = new Set(ptrEntries.map((entry) => entry.id));
      for (const entry of ptrEntries) {
        addSignal(candidates, entry, messages, false, `Reverse DNS ${intel.ptr} (confirmed)`, true);
        addEvidence(allEvidence, `Reverse DNS ${intel.ptr} (confirmed)`);
      }

      if (intel.asn !== null) {
        for (const entry of entriesForAsn(intel.asn)) {
          const existing = candidates.get(entry.id);
          // An ASN is a second signal, never the only one, and the same IP's
          // PTR already contributed this message count for the same service.
          if (existing?.verified && !ptrMatched.has(entry.id)) {
            addSignal(candidates, entry, messages, false, `AS${intel.asn} ${intel.asnName ?? ''}`.trim());
            addEvidence(allEvidence, `AS${intel.asn} ${intel.asnName ?? ''}`.trim());
          }
        }
      }
    } else if (intel.asn !== null) {
      for (const entry of entriesForAsn(intel.asn)) {
        const existing = candidates.get(entry.id);
        if (existing?.verified) {
          addSignal(candidates, entry, messages, false, `AS${intel.asn} ${intel.asnName ?? ''}`.trim());
          addEvidence(allEvidence, `AS${intel.asn} ${intel.asnName ?? ''}`.trim());
        }
      }
      addEvidence(allEvidence, `AS${intel.asn} ${intel.asnName ?? ''}`.trim());
    }
  }

  if (network) {
    addEvidence(allEvidence, `AS${network.asn} ${network.asnName ?? ''}`.trim());
  }

  const winner = choose(candidates);
  if (winner) {
    const winnerEvidence = candidateEvidence(winner);
    const evidence = [...new Set([...winnerEvidence, ...allEvidence])].slice(0, 5);
    return {
      service: {
        id: winner.entry.id,
        name: winner.entry.name,
        category: winner.entry.category,
      },
      confidence: winner.confirmed ? 'confirmed' : 'likely',
      network,
      evidence,
      intelPending: input.intelPending,
    };
  }

  if (own) {
    return { service: null, confidence: 'own', network, evidence: allEvidence.slice(0, 5), intelPending: input.intelPending };
  }
  if (network) {
    return { service: null, confidence: 'network', network, evidence: allEvidence.slice(0, 5), intelPending: input.intelPending };
  }
  return { service: null, confidence: 'unknown', network: null, evidence: [], intelPending: input.intelPending };
}

function candidateEvidence(candidate: Candidate): string[] {
  // The winning service's own lines first; other services remain in the list
  // the caller merges, so a mixed sender is not silently reduced to one name.
  return candidate.evidence.slice(0, 5);
}

/** One IP's service and confidence, for the Sources table and PDF top sources. */
export function attributeSourceIp(input: {
  reportedDomain: string;
  ip: string;
  messages: number;
  signals: AuthSignal[];
  intel: CachedIntel | null;
}): { service: SenderService | null; confidence: SenderConfidence } {
  const intel = input.intel ? new Map([[input.ip, input.intel]]) : new Map<string, CachedIntel>();
  const attributed = attributeSender({
    reportedDomain: input.reportedDomain,
    signals: input.signals,
    ipMessages: new Map([[input.ip, input.messages]]),
    intel,
    intelPending: !input.intel,
  });
  return { service: attributed.service, confidence: attributed.confidence };
}
