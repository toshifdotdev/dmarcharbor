import { describe, expect, it } from 'vitest';
import {
  alignmentModeFromTag,
  isAligned,
  organizationalDomain,
  resolveAlignedSender,
} from '../src/services/alignment.service.js';
import { parseDmarcReport } from '../src/services/report-parser.service.js';

/**
 * RFC 7489 section 3.1.1 alignment.
 *
 * This was wrong in a way that produced false alarms. The parser compared the
 * authenticating domain to the policy domain by exact string equality, so a
 * sender signing as `mail.acme.com` against a policy of `acme.com` was recorded
 * as unattributed. Almost every real deployment signs on a subdomain, which
 * meant the spoofing detector fired on legitimate vendors and a customer's
 * genuine alert was buried under invented ones.
 *
 * The relaxed rule has one way to be implemented badly, and it is tested here:
 * plain "is one a suffix of the other" matching would make every GitHub Pages
 * customer aligned with every other, so one Pages account could send as any of
 * them. Alignment is therefore defined on organisational domains.
 */

describe('organisational domain', () => {
  it('takes the registrable domain', () => {
    expect(organizationalDomain('acme.com')).toBe('acme.com');
    expect(organizationalDomain('mail.acme.com')).toBe('acme.com');
    expect(organizationalDomain('deep.nested.mail.acme.com')).toBe('acme.com');
  });

  it('keeps multi tenant tenants separate', () => {
    // The whole reason the public suffix list matters. If these matched, an
    // attacker with one Pages account could send as any other Pages customer.
    expect(organizationalDomain('victim.github.io')).not.toBe(organizationalDomain('attacker.github.io'));
    expect(organizationalDomain('victim.github.io')).toBe('victim.github.io');

    // Each site is its own tenant. Written this way round it would be wrong:
    // a.customer and b.customer are both subdomains of whoever owns
    // customer.azurewebsites.net, so under public suffix rules they legitimately
    // share an organisation.
    expect(organizationalDomain('a.azurewebsites.net')).not.toBe(organizationalDomain('b.azurewebsites.net'));
    expect(organizationalDomain('mail.a.azurewebsites.net')).toBe(organizationalDomain('a.azurewebsites.net'));
  });

  it('still aligns within one multi tenant tenant', () => {
    expect(organizationalDomain('victim.github.io')).toBe(organizationalDomain('mail.victim.github.io'));
  });

  it('handles two label public suffixes without the full list', () => {
    // Without this, every .co.uk domain would share the organisational domain
    // `co.uk` and therefore align with each other.
    expect(organizationalDomain('acme.co.uk')).toBe('acme.co.uk');
    expect(organizationalDomain('other.co.uk')).not.toBe('acme.co.uk');
    expect(organizationalDomain('shop.acme.co.uk')).toBe('acme.co.uk');
  });
});

describe('alignment modes', () => {
  it('reads the mode the policy domain declared', () => {
    expect(alignmentModeFromTag('r')).toBe('relaxed');
    expect(alignmentModeFromTag('s')).toBe('strict');
    expect(alignmentModeFromTag(undefined)).toBe('relaxed');
    expect(alignmentModeFromTag('S')).toBe('strict');
  });

  it('aligns an exact match in both modes', () => {
    expect(isAligned('acme.com', 'acme.com', 'relaxed')).toBe(true);
    expect(isAligned('acme.com', 'acme.com', 'strict')).toBe(true);
  });

  it('aligns a subdomain only in relaxed mode', () => {
    // The bug this whole piece exists to fix.
    expect(isAligned('mail.acme.com', 'acme.com', 'relaxed')).toBe(true);
    expect(isAligned('mail.acme.com', 'acme.com', 'strict')).toBe(false);
  });

  it('aligns a sibling subdomain in relaxed mode', () => {
    expect(isAligned('email.acme.com', 'mail.acme.com', 'relaxed')).toBe(true);
  });

  it('does not align a different organisation', () => {
    expect(isAligned('evil.com', 'acme.com', 'relaxed')).toBe(false);
    expect(isAligned('acme.com.evil.com', 'acme.com', 'relaxed')).toBe(false);
    expect(isAligned('notacme.com', 'acme.com', 'relaxed')).toBe(false);
  });

  it('does not align two tenants of one multi tenant host', () => {
    expect(isAligned('attacker.github.io', 'victim.github.io', 'relaxed')).toBe(false);
    expect(isAligned('mail.victim.github.io', 'victim.github.io', 'relaxed')).toBe(true);
  });

  it('aligns nothing without a domain on either side', () => {
    expect(isAligned(undefined, 'acme.com', 'relaxed')).toBe(false);
    expect(isAligned('acme.com', undefined, 'relaxed')).toBe(false);
    expect(isAligned('', '', 'relaxed')).toBe(false);
  });

  it('ignores a trailing dot and case, because DNS does', () => {
    expect(isAligned('MAIL.Acme.COM.', 'acme.com', 'relaxed')).toBe(true);
  });
});

describe('attributing a record to a sender', () => {
  it('prefers an aligned authentication domain', () => {
    const resolved = resolveAlignedSender({
      policyDomain: 'acme.com',
      headerFrom: 'acme.com',
      authResults: [
        { type: 'SPF', domain: 'mail.acme.com', scope: 'mfrom', result: 'pass' },
      ],
    });

    expect(resolved.senderDomain).toBe('mail.acme.com');
    expect(resolved.matched).toBe(true);
  });

  it('applies adkim and aspf to the protocol each one governs', () => {
    // aspf=s asks for strict SPF, and that must not soften DKIM.
    const resolved = resolveAlignedSender({
      policyDomain: 'acme.com',
      aspf: 's',
      adkim: 'r',
      authResults: [
        { type: 'SPF', domain: 'mail.acme.com', scope: 'mfrom', result: 'pass' },
        { type: 'DKIM', domain: 'news.acme.com', selector: 's1', result: 'pass' },
      ],
    });

    // DKIM is relaxed, so the subdomain matches and wins.
    expect(resolved.senderDomain).toBe('news.acme.com');
    expect(resolved.matched).toBe(true);
  });

  it('refuses relaxed matching when the domain asked for strict', () => {
    const resolved = resolveAlignedSender({
      policyDomain: 'acme.com',
      aspf: 's',
      adkim: 's',
      authResults: [{ type: 'SPF', domain: 'mail.acme.com', scope: 'mfrom', result: 'pass' }],
    });

    expect(resolved.senderDomain).toBe('mail.acme.com');
    expect(resolved.matched).toBe(false);
  });

  it('falls back to header_from only when there is no auth result at all', () => {
    const resolved = resolveAlignedSender({
      policyDomain: 'acme.com',
      headerFrom: 'Example.COM',
      envelopeFrom: 'mail.example.com',
      authResults: [],
    });

    // A `??` chain that returned an empty string rather than undefined would
    // stop here and produce nothing, which is exactly what it did.
    expect(resolved.senderDomain).toBe('example.com');
  });

  it('prefers what authenticated over what the message claimed', () => {
    const resolved = resolveAlignedSender({
      policyDomain: 'acme.com',
      headerFrom: 'acme.com',
      authResults: [{ type: 'SPF', domain: 'spammer.test', scope: 'mfrom', result: 'fail' }],
    });

    expect(resolved.senderDomain).toBe('spammer.test');
    expect(resolved.matched).toBe(false);
  });
});

describe('the parser honours it end to end', () => {
  function report(domain: string, adkim: string, aspf: string, dkimDomain: string, spfDomain: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<feedback>
  <report_metadata>
    <org_name>Google LLC</org_name><report_id>align-1</report_id>
    <date_range><begin>1712188800</begin><end>1712275199</end></date_range>
  </report_metadata>
  <policy_published>
    <domain>${domain}</domain><adkim>${adkim}</adkim><aspf>${aspf}</aspf><p>none</p>
  </policy_published>
  <record>
    <row>
      <source_ip>192.0.2.10</source_ip><count>100</count>
      <policy_evaluated><disposition>none</disposition><dkim>pass</dkim><spf>pass</spf></policy_evaluated>
    </row>
    <identifiers><header_from>${domain}</header_from><envelope_from>${domain}</envelope_from></identifiers>
    <auth_results>
      <dkim><domain>${dkimDomain}</domain><selector>s1</selector><result>pass</result></dkim>
      <spf><domain>${spfDomain}</domain><scope>mfrom</scope><result>pass</result></spf>
    </auth_results>
  </record>
</feedback>`;
  }

  it('attributes a subdomain sender instead of losing it', () => {
    const parsed = parseDmarcReport(report('acme.com', 'r', 'r', 'news.acme.com', 'mail.acme.com'));

    // Before the fix this fell through to header_from and recorded the record as
    // unattributed, which is what raised the false spoofing alerts.
    expect(parsed.records[0].senderDomain).toBe('news.acme.com');
    expect(parsed.records[0].senderKey).toBe('news.acme.com');
  });

  it('keeps strict mode strict through the parser', () => {
    const parsed = parseDmarcReport(report('acme.com', 's', 's', 'news.acme.com', 'mail.acme.com'));

    // adkim=s and aspf=s, so neither subdomain is aligned and the parser must
    // not pretend otherwise.
    expect(parsed.records[0].senderDomain).toBe('news.acme.com');
    expect(parsed.policyAdkim).toBe('s');
    expect(parsed.policyAspf).toBe('s');
  });
});