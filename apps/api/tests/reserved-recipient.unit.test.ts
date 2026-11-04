import { describe, expect, it } from 'vitest';
import { UndeliverableRecipientError, undeliverableReason } from '../src/email/reserved-recipient.js';

describe('reserved recipients', () => {
  it('refuses the reserved top-level domains', () => {
    for (const address of [
      'toshif@dmarcharbor.test',
      'it@pellowyn.example',
      'owner@verify.invalid',
      'dev@machine.localhost',
      'SAM@EXAMPLE.TEST',
      'trailing@dot.test.',
    ]) {
      expect(undeliverableReason(address), address).not.toBeNull();
    }
  });

  it('refuses the reserved second-level domains and their subdomains', () => {
    for (const address of ['owner@example.com', 'a@mail.example.net', 'b@example.org']) {
      expect(undeliverableReason(address), address).not.toBeNull();
    }
  });

  it('reads the address out of a display-name form', () => {
    expect(undeliverableReason('Pellowyn Dental <it@pellowyn.example>')).toContain('.example');
    expect(undeliverableReason('DMARC Harbor <dmarcharbor+test1@gmail.com>')).toBeNull();
  });

  it('allows real domains, including ones that only look reserved', () => {
    for (const address of ['dmarcharbor+test1@gmail.com', 'dmarcharbor@outlook.com', 'it@myexample.com', 'a@test.co.uk', 'b@examples.org']) {
      expect(undeliverableReason(address), address).toBeNull();
    }
  });

  it('refuses something that is not an address at all', () => {
    expect(undeliverableReason('nobody')).toBe('not an email address');
    expect(undeliverableReason('@gmail.com')).toBe('not an email address');
  });

  it('names the recipient and the reason in its error', () => {
    const error = new UndeliverableRecipientError('toshif@dmarcharbor.test', '.test is a reserved top-level domain');
    expect(error.message).toBe('Not sent to toshif@dmarcharbor.test: .test is a reserved top-level domain.');
  });
});
