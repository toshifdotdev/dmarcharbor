import { z } from 'zod';

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
  error?: string;
}

export interface SpfResult {
  status: LookupStatus;
  record?: string;
  valid: boolean;
  lookupCount: number;
  error?: string;
}

export interface DkimResult {
  status: LookupStatus;
  selectors: string[];
  checkedSelectors: string[];
  records: Record<string, string>;
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
  issues: ScanIssue[];
  recommendations: string[];
}

export interface DnsReader {
  resolveTxt(name: string): Promise<LookupResult<string[][]>>;
  resolveMx(name: string): Promise<LookupResult<MxRecord[]>>;
}

export const scanRequestSchema = z.object({
  domain: z.string().trim().min(1).max(253),
});

export type ScanRequest = z.infer<typeof scanRequestSchema>;
