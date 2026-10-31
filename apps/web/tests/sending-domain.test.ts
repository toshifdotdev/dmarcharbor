import { describe, expect, it } from 'vitest';
import { sendingCheckNotice, sendingDomainOf, sendingDomainPhase, sendingRecordPhase } from '../lib/sending-domain.js';

/**
 * An agency's own sending domain is in one of three states on the settings
 * page. Only the API's verified flag says "Verified", because that is what
 * switches client email to the address; anything the provider has not settled
 * is "Waiting for DNS", so an unknown status never reads as live.
 */

describe('sendingDomainPhase', () => {
  it('is verified only when the API says so', () => {
    expect(sendingDomainPhase({ status: 'verified', verified: true })).toBe('verified');
    expect(sendingDomainPhase({ status: 'verified', verified: false })).toBe('waiting');
  });

  it('is waiting while the provider has not seen the records', () => {
    for (const status of ['not_started', 'pending', 'partially_verified', 'temporary_failure', 'something_new', null, undefined]) {
      expect(sendingDomainPhase({ status, verified: false }), String(status)).toBe('waiting');
    }
  });

  it('is failed when the provider looked and the records are wrong', () => {
    expect(sendingDomainPhase({ status: 'failed', verified: false })).toBe('failed');
    expect(sendingDomainPhase({ status: 'partially_failed', verified: false })).toBe('failed');
  });
});

describe('sendingRecordPhase', () => {
  it('reads one record from its own status', () => {
    expect(sendingRecordPhase('verified')).toBe('verified');
    expect(sendingRecordPhase('failed')).toBe('failed');
    expect(sendingRecordPhase('not_started')).toBe('waiting');
    expect(sendingRecordPhase('pending')).toBe('waiting');
    expect(sendingRecordPhase(undefined)).toBe('waiting');
  });
});

describe('sendingCheckNotice', () => {
  it('says to check again shortly while the provider has not seen the records', () => {
    expect(sendingCheckNotice({ sendingAddress: 'reports@mail.agency.example', status: 'pending', verified: false })).toEqual({
      tone: 'warn',
      text: 'Your email provider has not seen the records yet. Publishing can take a few minutes; check again shortly.',
    });
  });

  it('names the address once it is verified', () => {
    const notice = sendingCheckNotice({ sendingAddress: 'reports@mail.agency.example', status: 'verified', verified: true });
    expect(notice.tone).toBe('ok');
    expect(notice.text).toContain('reports@mail.agency.example');
  });

  it('is a failure when the provider could not verify them', () => {
    expect(sendingCheckNotice({ sendingAddress: 'reports@mail.agency.example', status: 'failed', verified: false }).tone).toBe('fail');
  });
});

describe('sendingDomainOf', () => {
  it('is the part after the @', () => {
    expect(sendingDomainOf('reports@Mail.Agency.example')).toBe('mail.agency.example');
    expect(sendingDomainOf(null)).toBeNull();
    expect(sendingDomainOf('reports@')).toBeNull();
    expect(sendingDomainOf('no-at-sign')).toBeNull();
  });
});
