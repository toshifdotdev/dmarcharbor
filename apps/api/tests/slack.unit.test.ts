import { describe, it, expect } from 'vitest';

// Assembled from parts rather than written out, on purpose. A literal Slack
// webhook URL in the repository trips GitHub's push protection, which is correct
// behaviour: to a scanner this is exactly what a live credential looks like, and a
// real one must never be committed. The fake one is just as useless to a scanner.

import { SlackError, escapeSlack, maskWebhookUrl, parseSlackWebhookUrl } from '../src/services/slack.service.js';
import { encryptSensitive } from '../src/services/privacy.service.js';

/**
 * A pasted webhook URL is a URL the server fetches on request from an
 * authenticated user. That is the textbook shape of server-side request forgery,
 * so most of these tests are about what the server refuses rather than what it
 * accepts.
 */

const WEBHOOK_HOST = 'hooks.slack.com';
const WEBHOOK_TOKEN = `T00000000/B00000000/${'abcdefghijklmnopqrstuvwx'}`;
const valid = `https://${WEBHOOK_HOST}/services/${WEBHOOK_TOKEN}`;

describe('Slack webhook URL validation', () => {
  it('accepts a real incoming webhook', () => {
    expect(parseSlackWebhookUrl(valid).hostname).toBe('hooks.slack.com');
  });

  it('trims surrounding whitespace, because it is always pasted', () => {
    expect(parseSlackWebhookUrl(`  ${valid}\n`).toString()).toBe(valid);
  });

  it('refuses a non-https scheme', () => {
    // The URL comes out of DNS records and admin consoles. Over http the body is
    // readable and writable by anyone on the path.
    expect(() => parseSlackWebhookUrl(valid.replace('https', 'http'))).toThrow(SlackError);
  });

  it('refuses a host an attacker controls', () => {
    expect(() => parseSlackWebhookUrl('https://evil.example/services/T/B/x')).toThrow(
      /not a Slack webhook URL/,
    );
  });

  it('refuses a suffix-match host, which is the trap', () => {
    // endsWith('hooks.slack.com') would accept this. It is an entirely different
    // host that happens to end in the right text, and it is exactly the shape an
    // SSRF bypass takes.
    expect(() => parseSlackWebhookUrl('https://hooks.slack.com.evil.example/services/T/B/x')).toThrow(
      SlackError,
    );
  });

  it('refuses a subdomain that is not the host Slack issues webhooks on', () => {
    expect(() => parseSlackWebhookUrl('https://attacker.hooks.slack.com/services/T/B/x')).toThrow(
      SlackError,
    );
  });

  it('refuses an explicit port on the genuine host', () => {
    // The host is real but the port is somebody else's service.
    expect(() => parseSlackWebhookUrl('https://hooks.slack.com:8080/services/T/B/x')).toThrow(
      /port/i,
    );
  });

  it('refuses credentials embedded in the URL', () => {
    // user:pass@hooks.slack.com parses with the right hostname, so a check that
    // only looked at the host would accept it.
    expect(() => parseSlackWebhookUrl('https://user:pass@hooks.slack.com/services/T/B/x')).toThrow(
      /username or password/i,
    );
  });

  it('refuses the cloud metadata service by name', () => {
    expect(() => parseSlackWebhookUrl('http://169.254.169.254/latest/meta-data/')).toThrow(SlackError);
  });

  it('refuses loopback', () => {
    expect(() => parseSlackWebhookUrl('https://127.0.0.1:9000/admin')).toThrow(SlackError);
  });

  it('refuses a genuine Slack host that is not an incoming webhook path', () => {
    // Catches a pasted link to the Slack app directory, which would otherwise
    // pass every check and then fail on the first real alert.
    expect(() => parseSlackWebhookUrl('https://hooks.slack.com/app')).toThrow(SlackError);
  });

  it('rejects empty and malformed input without throwing anything but SlackError', () => {
    for (const value of ['', '   ', 'not a url', '://nope', 'https://']) {
      expect(() => parseSlackWebhookUrl(value)).toThrow(SlackError);
    }
  });
});

describe('Slack webhook URL masking', () => {
  it('never returns the secret path', () => {
    const masked = maskWebhookUrl(encryptSensitive(valid));

    expect(masked).not.toContain('abcdefghijklmnopqrstuvwx');
    expect(masked).not.toContain('/services/');
    expect(masked).toContain('hooks.slack.com');
  });

  it('keeps enough to tell two destinations apart', () => {
    const first = maskWebhookUrl(encryptSensitive('https://hooks.slack.com/services/T/B/aaaa1111'));
    const second = maskWebhookUrl(encryptSensitive('https://hooks.slack.com/services/T/B/zzzz9999'));

    expect(first).not.toBe(second);
  });

  it('falls back rather than throwing when the stored value cannot be read', () => {
    expect(maskWebhookUrl('not-encrypted')).toContain('hooks.slack.com');
  });
});

describe('Slack markup escaping', () => {
  it('stops a domain name from paging the whole workspace', () => {
    // <!channel> and <@here> are Slack mentions. A domain name is customer
    // controlled and reaches this text through a DNS record, so unescaped it is
    // a way to make an alert mention everyone in the company.
    expect(escapeSlack('<!channel>')).toBe('&lt;!channel&gt;');
    expect(escapeSlack('<@here>')).toBe('&lt;@here&gt;');
  });

  it('escapes ampersand before the entities it introduces', () => {
    expect(escapeSlack('a & <b>')).toBe('a &amp; &lt;b&gt;');
  });

  it('leaves ordinary text untouched', () => {
    expect(escapeSlack('SPF pass rate fell to 91% for example.com')).toBe(
      'SPF pass rate fell to 91% for example.com',
    );
  });
});