import { z } from 'zod';
import type { HttpsFailure } from '../scanner/https-get.js';

export type LookupStatus = 'found' | 'missing' | 'error';

export interface LookupResult<T> {
  status: LookupStatus;
  value?: T;
  error?: string;
}

export type ScanStatus = 'healthy' | 'needs_attention' | 'missing' | 'error';
export type DmarcPolicy = 'none' | 'quarantine' | 'reject' | 'unknown';

export interface ScanIssue {
  severity: 'info' | 'warning' | 'error';
  code: string;
  title: string;
  message: string;
  recommendation?: string;
}

export interface DmarcResult {
  status: LookupStatus;
  record?: string;
  policy: DmarcPolicy;
  tags: Record<string, string>;
  hasAggregateReports: boolean;
  hasForensicReports: boolean;
  /**
   * Where reports are published as mail, which we can receive.
   */
  aggregateMailtoTargets: string[];
  /**
   * Where reports are published over HTTP, which we cannot yet receive.
   *
   * Reported rather than dropped: a domain publishing only to a web endpoint is
   * a domain whose reports we are not getting, and that has to be visible rather
   * than inferred from an absent mailto address.
   */
  aggregateWebTargets: string[];
  /** t=y is published: the policy is in testing mode (RFC 9989 section 4.7). */
  testing?: boolean;
  /**
   * The CNAME target at _dmarc, when the reader can read CNAMEs. Undefined on
   * old scans and on reader doubles without resolveCname.
   */
  delegatedTo?: string | null;
  /**
   * What failing mail actually gets: the policy, one level softer while t=y
   * is published (quarantine is handled as none, reject as quarantine).
   */
  effectivePolicy?: DmarcPolicy;
  /** Findings about the record's tags, per RFC 9989. */
  notices?: ScanIssue[];
  error?: string;
}

export interface SpfLookupNode {
  /** The term as written, e.g. "include:_spf.google.com" or "mx". */
  term: string;
  /** DNS lookups this term costs, its own plus everything it includes. */
  lookups: number;
  children?: SpfLookupNode[];
  note?: string;
}

export interface SpfResult {
  status: LookupStatus;
  record?: string;
  valid: boolean;
  /**
   * DNS-querying terms a receiver evaluates (RFC 7208 section 4.6.4: include,
   * a, mx, ptr, exists and redirect), counted through every include and
   * redirect. This used to count only the top-level record, so a record of
   * three includes that each pull in four more read as 3 when receivers
   * count 15.
   */
  lookupCount: number;
  /** Lookups that returned no record (NXDOMAIN or an empty answer). */
  voidLookupCount?: number;
  /** More than 10 lookups: receivers return permerror and SPF fails. */
  lookupLimitExceeded?: boolean;
  /** More than 2 void lookups: receivers may return permerror. */
  voidLookupLimitExceeded?: boolean;
  /** Where the lookups come from, include by include. */
  lookupTree?: SpfLookupNode[];
  /** Faults found while following includes: loops, missing records, deprecated ptr. */
  problems?: string[];
  /** False when the walk stopped early (time or query budget, DNS errors). */
  lookupsComplete?: boolean;
  error?: string;
}

export interface DkimResult {
  status: LookupStatus;
  selectors: string[];
  checkedSelectors: string[];
  records: Record<string, string>;
  /**
   * Why each selector was probed.
   *
   * "found a key" is not debuggable on its own. Knowing a selector came from an
   * SPF include rather than from a convention tells support whether to trust the
   * answer and where to look next, which is the difference between a five minute
   * answer and a support ticket.
   */
  discoveredVia?: Record<string, string>;
  /**
   * Candidates the lookup budget excluded.
   *
   * Surfaced rather than silently dropped, because "we checked 25 and gave up"
   * is a materially different claim from "we checked everything".
   */
  skippedSelectors?: string[];
  /** Selectors publishing an empty p=, which RFC 6376 defines as a revoked key. */
  revokedSelectors?: string[];
  error?: string;
}

export interface MxRecord {
  exchange: string;
  priority: number;
}

export interface MxResult {
  status: LookupStatus;
  records: MxRecord[];
  error?: string;
}

export type MtaStsMode = 'enforce' | 'testing' | 'none';

export interface MtaStsResult {
  status: LookupStatus;
  record?: string;
  id?: string;
  /** Set when status is found but the record is unusable. */
  recordProblem?: string;
  /** Null unless exactly one valid TXT record was found. */
  policy: null | {
    url: string;
    status: 'fetched' | 'unavailable' | 'invalid';
    failure?: HttpsFailure | 'content_type';
    httpStatus?: number;
    detail?: string;
    mode?: MtaStsMode;
    maxAge?: number;
    mx?: string[];
    problems: string[];
    /** The policy as served, first 2,000 characters, always shown as plain text. */
    text?: string;
  };
  mxCoverage?: Array<{ host: string; covered: boolean }>;
  error?: string;
}

export interface TlsRptResult {
  status: LookupStatus;
  record?: string;
  valid: boolean;
  mailtoTargets: string[];
  httpsTargets: string[];
  problems: string[];
  error?: string;
}

export interface BimiResult {
  status: LookupStatus;
  record?: string;
  /** Set when this domain had no record and the organisational domain's applies. */
  inheritedFrom?: string;
  logoUrl: string | null;
  authorityUrl: string | null;
  /** l= present and empty: this domain opts out of BIMI. */
  declined: boolean;
  problems: string[];
  /**
   * dependsOnParent: a subdomain with no DMARC record of its own, so the
   * parent's record decides and this scan cannot. qualifies is then false
   * but no finding is raised.
   */
  dmarc: { qualifies: boolean; reasons: string[]; dependsOnParent?: true };
  logo: null | {
    status: 'fetched' | 'unavailable' | 'invalid';
    failure?: HttpsFailure;
    detail?: string;
    bytes?: number;
    checks?: {
      svgRoot: boolean;
      tinyPsProfile: boolean;
      version12: boolean;
      title: boolean;
      noForbiddenElements: boolean;
      noExternalReferences: boolean;
      withinSizeLimit: boolean;
    };
  };
  error?: string;
}

export interface ScoreFactor {
  code: string;
  label: string;
  points: number;
  description: string;
}

export interface ScoreBreakdown {
  base: number;
  final: number;
  factors: ScoreFactor[];
}

export interface ScanResult {
  domain: string;
  scannedAt: string;
  status: ScanStatus;
  score: number;
  scoreBreakdown: ScoreBreakdown;
  dmarc: DmarcResult;
  spf: SpfResult;
  dkim: DkimResult;
  mx: MxResult;
  /** Optional: scans stored before the transport checks do not have these. */
  mtaSts?: MtaStsResult;
  tlsRpt?: TlsRptResult;
  bimi?: BimiResult;
  issues: ScanIssue[];
  recommendations: string[];
}

export interface DnsReader {
  resolveTxt(name: string): Promise<LookupResult<string[][]>>;
  resolveMx(name: string): Promise<LookupResult<MxRecord[]>>;
  /**
   * A and AAAA. Optional, so a reader that cannot answer it (most test
   * doubles) simply skips the void-lookup check for "a" terms.
   */
  resolveAddress?(name: string): Promise<LookupResult<string[]>>;
  /**
   * CNAME targets. Optional for the same reason as resolveAddress: a reader
   * that cannot answer leaves the switch planner without CNAME information
   * rather than failing the plan.
   */
  resolveCname?(name: string): Promise<LookupResult<string[]>>;
  /**
   * PTR names for an IP. Optional so existing reader doubles keep compiling;
   * the sender-intelligence job simply records no reverse DNS without it.
   */
  resolvePtr?(ip: string): Promise<LookupResult<string[]>>;
}

export const scanRequestSchema = z.object({
  domain: z.string().trim().min(1).max(253),
});

export type ScanRequest = z.infer<typeof scanRequestSchema>;
