import { describe, expect, it } from 'vitest';
import {
  newSenderBlockers,
  possibleSpoofingSources,
  senderBlockers,
  senderLabel,
  type SenderBreakdownRow,
} from '../src/services/sender-breakdown.service.js';

function row(overrides: Partial<SenderBreakdownRow> = {}): SenderBreakdownRow {
  return {
    senderKey: 'sendgrid.net',
    senderDomain: 'sendgrid.net',
    sourceIps: ['203.0.113.10'],
    failingSourceIps: ['203.0.113.10'],
    totalMessages: 100,
    failedMessages: 100,
    failureSharePercent: 100,
    dmarcFailedMessages: 100,
    dmarcFailureSharePercent: 100,
    hasEnoughSignal: true,
    status: 'failing',
    firstSeenAt: '2026-10-01T00:00:00.000Z',
    lastSeenAt: '2026-10-20T00:00:00.000Z',
    isNew: true,
    newSenderRisk: 'unauthenticated',
    dkimPassMessages: 0,
    spfPassMessages: 0,
    service: { id: 'sendgrid', name: 'SendGrid', category: 'transactional' },
    confidence: 'confirmed',
    network: { asn: 11377, asnName: 'SENDGRID' },
    evidence: ['DKIM d=sendgrid.net (pass)'],
    intelPending: false,
    review: {
      status: 'UNREVIEWED',
      note: null,
      reviewedAt: null,
      reviewedBy: null,
    },
    owner: null,
    ...overrides,
  };
}

describe('sender review effects', () => {
  it('uses the service name when a signal supports it', () => {
    expect(senderLabel(row())).toBe('SendGrid');
    expect(senderLabel(row({ service: null, confidence: 'own' }))).toBe('sendgrid.net');
  });

  it('lets a not-ours sender reach enforcement but keeps an approved failing sender blocking', () => {
    expect(senderBlockers([row({ review: { ...row().review, status: 'NOT_OURS' } })])).toEqual([]);

    const approved = senderBlockers([row({ review: { ...row().review, status: 'APPROVED' } })]);
    expect(approved).toHaveLength(1);
    expect(approved[0]).toContain('Approved sender SendGrid fails DMARC');
    expect(approved[0]).toContain('100%');

    expect(senderBlockers([row()])[0]).toContain('SendGrid fails DMARC on 100%');
  });

  it('skips reviewed senders in the new-sender blocker', () => {
    expect(newSenderBlockers([row({ newSenderRisk: 'partially-authenticated', failedMessages: 10 })])).toHaveLength(1);
    expect(
      newSenderBlockers([
        row({
          newSenderRisk: 'partially-authenticated',
          failedMessages: 10,
          review: { ...row().review, status: 'APPROVED' },
        }),
      ]),
    ).toHaveLength(0);
    expect(
      newSenderBlockers([
        row({
          newSenderRisk: 'partially-authenticated',
          failedMessages: 10,
          review: { ...row().review, status: 'NOT_OURS' },
        }),
      ]),
    ).toHaveLength(0);
  });

  it('excludes approved senders from spoofing and always lists a not-ours failure', () => {
    expect(
      possibleSpoofingSources([row({ review: { ...row().review, status: 'APPROVED' } })]),
    ).toHaveLength(0);

    const notOurs = possibleSpoofingSources([
      row({
        isNew: false,
        hasEnoughSignal: false,
        review: { ...row().review, status: 'NOT_OURS' },
      }),
    ]);
    expect(notOurs).toHaveLength(1);
    expect(notOurs[0]?.serviceName).toBe('SendGrid');
    expect(notOurs[0]?.detail).toContain('marked not ours');
  });
});
