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
  status: 'found' | 'missing' | 'error';
  record?: string;
  policy: DmarcPolicy;
  tags: Record<string, string>;
  hasAggregateReports: boolean;
  hasForensicReports: boolean;
  error?: string;
}

export interface SpfResult {
  status: 'found' | 'missing' | 'error';
  record?: string;
  valid: boolean;
  lookupCount: number;
  error?: string;
}

export interface DkimResult {
  status: 'found' | 'missing' | 'error';
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
  status: 'found' | 'missing' | 'error';
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
