import { scanDomain } from '../scanner/scanner.js';
import type { ScanRequest, ScanResult } from '../models/scan.model.js';

export function executeScan(request: ScanRequest): Promise<ScanResult> {
  return scanDomain(request.domain);
}
