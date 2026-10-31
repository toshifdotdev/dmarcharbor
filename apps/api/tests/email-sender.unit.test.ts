import { afterEach, describe, expect, it } from 'vitest';
import { env } from '../src/config/env.js';
import {
  addressOf,
  agencyFromHeader,
  clientEmailFrom,
  clientEmailHeaders,
  safeDisplayName,
  sharedFromHeader,
} from '../src/email/sender.js';

/**
 * The From line on an agency's client mail. The name is chosen by the agency,
 * so it is treated as untrusted text going into a mail header.
 */
describe('client email From header', () => {
  const original = { from: env.EMAIL_FROM, client: env.CLIENT_EMAIL_FROM_ADDRESS };

  afterEach(() => {
    env.EMAIL_FROM = original.from;
    env.CLIENT_EMAIL_FROM_ADDRESS = original.client;
  });

  it('reads the address out of EMAIL_FROM in either form', () => {
    expect(addressOf('DMARC Harbor <no-reply@harbor.example>')).toBe('no-reply@harbor.example');
    expect(addressOf('no-reply@ci.local.test')).toBe('no-reply@ci.local.test');
    expect(addressOf('Nobody at all')).toBeNull();
  });

  it('uses CLIENT_EMAIL_FROM_ADDRESS with the agency name in front', () => {
    env.CLIENT_EMAIL_FROM_ADDRESS = 'reports@mail-relay.example';

    expect(agencyFromHeader('Wistholm IT')).toBe('"Wistholm IT" <reports@mail-relay.example>');
  });

  it('falls back to the address part of EMAIL_FROM', () => {
    env.CLIENT_EMAIL_FROM_ADDRESS = undefined;
    env.EMAIL_FROM = 'DMARC Harbor <alerts@harbor.example>';

    expect(agencyFromHeader('Pellowyn Dental')).toBe('"Pellowyn Dental" <alerts@harbor.example>');
  });

  it('cannot be used to start another header or break out of the quotes', () => {
    env.CLIENT_EMAIL_FROM_ADDRESS = 'reports@mail-relay.example';

    const header = agencyFromHeader('Evil"\r\nBcc: victim@example.com\r\n<x@y> \\ Corp');

    expect(header).not.toMatch(/[\r\n]/);
    expect(header).toBe('"Evil Bcc: victim@example.com x@y Corp" <reports@mail-relay.example>');
  });

  it('keeps the name short, and drops to the bare address when nothing is left', () => {
    env.CLIENT_EMAIL_FROM_ADDRESS = 'reports@mail-relay.example';

    expect(safeDisplayName('A'.repeat(200))).toHaveLength(64);
    expect(safeDisplayName('  Corriwick   Café  ')).toBe('Corriwick Café');
    expect(agencyFromHeader('"<>"')).toBe('reports@mail-relay.example');
  });

  it('only names the agency when its white label is on', () => {
    env.CLIENT_EMAIL_FROM_ADDRESS = 'reports@mail-relay.example';

    expect(clientEmailFrom({ branded: true, workspaceName: 'Haskerley Law' })).toBe('"Haskerley Law" <reports@mail-relay.example>');
    expect(clientEmailFrom({ branded: false, workspaceName: 'Haskerley Law' })).toBeUndefined();
    expect(clientEmailFrom(null)).toBeUndefined();
  });

  it("uses the agency's own verified address when it is given one", () => {
    env.CLIENT_EMAIL_FROM_ADDRESS = 'reports@mail-relay.example';

    expect(agencyFromHeader('Wistholm IT', 'reports@mail.wistholm.example')).toBe(
      '"Wistholm IT" <reports@mail.wistholm.example>',
    );
    // Absent or null falls back to the shared address, as before.
    expect(agencyFromHeader('Wistholm IT', null)).toBe('"Wistholm IT" <reports@mail-relay.example>');
    // An address that could start another header is dropped, not sent.
    expect(agencyFromHeader('Wistholm IT', 'reports@mail.wistholm.example\r\nBcc: x@y.example')).toBe(
      '"Wistholm IT" <reports@mail-relay.example>',
    );
    expect(agencyFromHeader('Wistholm IT', '"x" <reports@mail.wistholm.example>')).toBe(
      '"Wistholm IT" <reports@mail-relay.example>',
    );
  });
});

describe('the shared From fallback', () => {
  const original = { from: env.EMAIL_FROM, client: env.CLIENT_EMAIL_FROM_ADDRESS };

  afterEach(() => {
    env.EMAIL_FROM = original.from;
    env.CLIENT_EMAIL_FROM_ADDRESS = original.client;
  });

  it('keeps the display name and swaps in the shared address', () => {
    env.CLIENT_EMAIL_FROM_ADDRESS = 'reports@mail-relay.example';

    expect(sharedFromHeader('"Wistholm IT" <reports@mail.wistholm.example>')).toBe(
      '"Wistholm IT" <reports@mail-relay.example>',
    );
    expect(sharedFromHeader('Pellowyn Dental <hello@mail.pellowyn.example>')).toBe(
      '"Pellowyn Dental" <reports@mail-relay.example>',
    );
  });

  it('falls back to the address part of EMAIL_FROM', () => {
    env.CLIENT_EMAIL_FROM_ADDRESS = undefined;
    env.EMAIL_FROM = 'DMARC Harbor <alerts@harbor.example>';

    expect(sharedFromHeader('"Wistholm IT" <reports@mail.wistholm.example>')).toBe('"Wistholm IT" <alerts@harbor.example>');
  });

  it('has nothing to offer when there is no name or the address is already shared', () => {
    env.CLIENT_EMAIL_FROM_ADDRESS = 'reports@mail-relay.example';

    expect(sharedFromHeader('reports@mail.wistholm.example')).toBeUndefined();
    expect(sharedFromHeader('"Wistholm IT" <reports@mail-relay.example>')).toBeUndefined();
    expect(sharedFromHeader('"Wistholm IT" <REPORTS@mail-relay.example>')).toBeUndefined();
  });
});

describe('client email headers', () => {
  const original = { from: env.EMAIL_FROM, client: env.CLIENT_EMAIL_FROM_ADDRESS };

  afterEach(() => {
    env.EMAIL_FROM = original.from;
    env.CLIENT_EMAIL_FROM_ADDRESS = original.client;
  });

  it('is nothing at all below white label', () => {
    expect(clientEmailHeaders(null)).toEqual({});
    expect(clientEmailHeaders(undefined)).toEqual({});
    expect(
      clientEmailHeaders({
        branded: false,
        workspaceName: 'Wistholm IT',
        supportEmail: 'help@wistholm.example',
        sendingAddress: 'reports@mail.wistholm.example',
      }),
    ).toEqual({});
  });

  it("sends in the agency's name with its support address as Reply-To", () => {
    env.CLIENT_EMAIL_FROM_ADDRESS = 'reports@mail-relay.example';

    expect(clientEmailHeaders({ branded: true, workspaceName: 'Wistholm IT', supportEmail: 'help@wistholm.example' })).toEqual({
      from: '"Wistholm IT" <reports@mail-relay.example>',
      replyTo: 'help@wistholm.example',
    });
  });

  it('has no Reply-To without a support address, and never invents one', () => {
    env.CLIENT_EMAIL_FROM_ADDRESS = 'reports@mail-relay.example';

    expect(clientEmailHeaders({ branded: true, workspaceName: 'Wistholm IT' })).toEqual({
      from: '"Wistholm IT" <reports@mail-relay.example>',
    });
    expect(clientEmailHeaders({ branded: true, workspaceName: 'Wistholm IT', supportEmail: null })).toEqual({
      from: '"Wistholm IT" <reports@mail-relay.example>',
    });
  });

  it("uses the agency's verified sending address when it has one", () => {
    env.CLIENT_EMAIL_FROM_ADDRESS = 'reports@mail-relay.example';

    expect(
      clientEmailHeaders({
        branded: true,
        workspaceName: 'Wistholm IT',
        supportEmail: 'help@wistholm.example',
        sendingAddress: 'reports@mail.wistholm.example',
      }),
    ).toEqual({ from: '"Wistholm IT" <reports@mail.wistholm.example>', replyTo: 'help@wistholm.example' });
  });

  it('drops a Reply-To that could start another header', () => {
    env.CLIENT_EMAIL_FROM_ADDRESS = 'reports@mail-relay.example';

    const headers = clientEmailHeaders({
      branded: true,
      workspaceName: 'Wistholm IT',
      supportEmail: 'help@wistholm.example\r\nBcc: victim@elsewhere.example',
    });

    expect(headers.replyTo).toBeUndefined();
    expect(JSON.stringify(headers)).not.toMatch(/\\r|\\n/);
  });
});
