import type { ScanResult } from './types';

interface ApiErrorPayload {
  error?: {
    message?: string;
  };
}

export async function scanDomain(domain: string): Promise<ScanResult> {
  const response = await fetch('/api/scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ domain }),
  });

  const payload = (await response.json()) as ScanResult | ApiErrorPayload;

  if (!response.ok) {
    const message = 'error' in payload && payload.error?.message ? payload.error.message : 'The scan could not be completed.';
    throw new Error(message);
  }

  return payload as ScanResult;
}
