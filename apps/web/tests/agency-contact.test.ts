import { describe, expect, it } from 'vitest';
import { agencyContact, mailtoHref, supportEmailOrNull, supportUrlOrNull } from '../lib/agency-contact.js';
import { parseHostBrand } from '../lib/host-brand.js';

/**
 * The support contact an agency publishes to its clients reaches a page as a
 * mailto: link and an href. It arrives from the API and through the proxy's
 * x-harbor-brand header, so it is checked again before use: a value that is
 * not one plain address or a full https page is dropped, never rendered.
 */

describe('supportEmailOrNull', () => {
  it('keeps one plain address and lowercases its domain', () => {
    expect(supportEmailOrNull('help@agency.example')).toBe('help@agency.example');
    expect(supportEmailOrNull('  Help.Desk+clients@Mail.Agency.Example ')).toBe('Help.Desk+clients@mail.agency.example');
    // Surrounding whitespace, a trailing line break included, is trimmed, as the API does.
    expect(supportEmailOrNull('help@agency.example\n')).toBe('help@agency.example');
  });

  it('drops anything that is not one plain address', () => {
    for (const value of [
      '',
      '   ',
      'help',
      'help@',
      '@agency.example',
      'help@agency',
      'help@agency..example',
      'help@-agency.example',
      'a@b@agency.example',
      'Help Desk <help@agency.example>',
      '"help"@agency.example',
      'help@agency.example, other@agency.example',
      'help@agency.example;other@agency.example',
      'help @agency.example',
      'help@agency.example\r\nBcc: someone@else.example',
      'help\u0085@agency.example',
      'javascript:alert(1)@agency.example',
      `${'a'.repeat(65)}@agency.example`,
    ]) {
      expect(supportEmailOrNull(value), JSON.stringify(value)).toBeNull();
    }
  });

  it('drops a value that is not a string', () => {
    for (const value of [null, undefined, 42, {}, ['help@agency.example']]) {
      expect(supportEmailOrNull(value)).toBeNull();
    }
  });
});

describe('supportUrlOrNull', () => {
  it('keeps a full https address', () => {
    expect(supportUrlOrNull('https://agency.example/help')).toBe('https://agency.example/help');
    expect(supportUrlOrNull(' https://help.agency.example ')).toBe('https://help.agency.example/');
  });

  it('drops a page that is not https', () => {
    for (const value of [
      'http://agency.example/help',
      'javascript:alert(1)',
      'JAVASCRIPT:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'mailto:help@agency.example',
      'ftp://agency.example/help',
      '//agency.example/help',
      '/help',
      'agency.example/help',
      '',
    ]) {
      expect(supportUrlOrNull(value), JSON.stringify(value)).toBeNull();
    }
  });

  it('drops a page with credentials, a line break or too many characters', () => {
    expect(supportUrlOrNull('https://user:secret@agency.example/help')).toBeNull();
    expect(supportUrlOrNull('https://agency.example/help\r\nx')).toBeNull();
    expect(supportUrlOrNull(`https://agency.example/${'a'.repeat(500)}`)).toBeNull();
    expect(supportUrlOrNull(42)).toBeNull();
  });
});

describe('agencyContact', () => {
  it('is null when neither value survives, so nothing is shown', () => {
    expect(agencyContact(null)).toBeNull();
    expect(agencyContact({ supportEmail: null, supportUrl: null })).toBeNull();
    expect(agencyContact({ supportEmail: 'not an address', supportUrl: 'http://agency.example' })).toBeNull();
  });

  it('keeps each value that survives on its own', () => {
    expect(agencyContact({ supportEmail: 'help@agency.example', supportUrl: 'javascript:alert(1)' })).toEqual({
      email: 'help@agency.example',
      url: null,
    });
    expect(agencyContact({ supportEmail: 'Help <help@agency.example>', supportUrl: 'https://agency.example/help' })).toEqual({
      email: null,
      url: 'https://agency.example/help',
    });
  });
});

describe('mailtoHref', () => {
  it('keeps a query character before the @ as part of the address', () => {
    expect(mailtoHref('help@agency.example')).toBe('mailto:help@agency.example');
    expect(mailtoHref('help?cc=x@agency.example')).toBe('mailto:help%3Fcc%3Dx@agency.example');
  });
});

describe('parseHostBrand', () => {
  it('reads the agency contact from the proxy header', () => {
    const brand = parseHostBrand(
      JSON.stringify({
        workspaceName: 'Wistholm IT',
        logoUrl: null,
        primaryColor: '#0f766e',
        accentColor: null,
        supportEmail: 'help@wistholm.example',
        supportUrl: 'https://wistholm.example/help',
      }),
    );
    expect(brand).toMatchObject({
      state: 'verified',
      workspaceName: 'Wistholm IT',
      supportEmail: 'help@wistholm.example',
      supportUrl: 'https://wistholm.example/help',
    });
  });

  it('drops a non-https page and a malformed email from the header', () => {
    const brand = parseHostBrand(
      JSON.stringify({
        workspaceName: 'Wistholm IT',
        supportEmail: 'help@wistholm.example\r\nBcc: x@else.example',
        supportUrl: 'javascript:alert(document.cookie)',
      }),
    );
    expect(brand.supportEmail).toBeNull();
    expect(brand.supportUrl).toBeNull();
    expect(brand.workspaceName).toBe('Wistholm IT');
  });

  it('reads a header written with escaped non-ASCII characters', () => {
    const raw = JSON.stringify({ workspaceName: 'Łódź IT', supportEmail: 'pomoc@lodz.example' }).replace(
      /[^\x20-\x7e]/g,
      (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
    );
    expect(parseHostBrand(raw)).toMatchObject({ workspaceName: 'Łódź IT', supportEmail: 'pomoc@lodz.example' });
  });

  it('is the default brand when the header is missing or unreadable', () => {
    for (const raw of [null, '', 'not json', 'null']) {
      const brand = parseHostBrand(raw);
      expect(brand.state).toBe('default');
      expect(brand.supportEmail).toBeNull();
      expect(brand.supportUrl).toBeNull();
    }
  });
});
