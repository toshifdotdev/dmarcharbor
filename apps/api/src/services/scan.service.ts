import { scanDomain } from '../scanner/scanner.js';
import type { ScanRequest, ScanResult } from '../models/scan.model.js';

/**
 * The public lookup. A selector, when given, is probed first and reported as
 * requested, so the DKIM lookup tool can answer for the selector a person
 * typed rather than only for the ones the scanner guesses.
 */
export function executeScan(request: ScanRequest): Promise<ScanResult> {
  return scanDomain(request.domain, undefined, request.selector ? { requestedSelectors: [request.selector] } : {});
}
