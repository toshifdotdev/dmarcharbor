import { describe, expect, it } from 'vitest';
import { digestEnvelope, webEndpointNote } from '../src/services/report-digest.service.js';

/**
 * Digests go to an agency's client contacts. With the agency's white label on
 * they must not name us anywhere, because the client knows only the agency.
 */
describe('digest wording', () => {
  const lines = ['Domain: pellowyn-dental.example', 'Client: Pellowyn Dental', ...webEndpointNote(true)];

  it('is the agency talking when white label is on', () => {
    const { subject, text } = digestEnvelope({
      domainName: 'pellowyn-dental.example',
      organizationName: 'Wistholm IT',
      branded: true,
      lines,
    });

    expect(subject).toBe('[Wistholm IT] pellowyn-dental.example DMARC summary');
    expect(text.startsWith('Prepared by Wistholm IT.')).toBe(true);
    expect(text).toContain('this service does not read them from there yet');
    expect(`${subject}\n${text}`).not.toContain('DMARC Harbor');
  });

  it('keeps today\'s wording when it is off', () => {
    const { subject, text } = digestEnvelope({
      domainName: 'pellowyn-dental.example',
      organizationName: 'Wistholm IT',
      branded: false,
      lines: ['Domain: pellowyn-dental.example', ...webEndpointNote(false)],
    });

    expect(subject).toBe('[DMARC Harbor] pellowyn-dental.example DMARC summary');
    expect(text.startsWith('Prepared by Wistholm IT.')).toBe(true);
    expect(text).toContain('DMARC Harbor does not read them from there yet');
    expect(text.endsWith('Prepared by DMARC Harbor.')).toBe(true);
  });

  it('keeps an agency name with a line break on one line in the subject', () => {
    const { subject } = digestEnvelope({
      domainName: 'thrandle.example',
      organizationName: 'Thrandle\r\nBuild',
      branded: true,
      lines: [],
    });

    expect(subject).toBe('[Thrandle Build] thrandle.example DMARC summary');
  });
});
