import { describe, expect, it } from 'vitest';
import {
  TeamsError,
  buildTeamsCard,
  maskTeamsWebhookUrl,
  parseTeamsWebhookUrl,
} from '../src/services/teams.service.js';

/**
 * The Teams address is the security boundary of this feature.
 *
 * Everything here is about one question: can a pasted string make this server
 * POST somewhere it should not? The two host families are the whole control, so
 * each refusal below is a way that control could have been talked around.
 *
 * The addresses are obviously fake (`prod-00`, `0000`) and the signature is
 * spelled `TESTSIGNOTREAL`, because GitHub push protection has rejected a push
 * from this repository before and a realistic-looking webhook is a credential.
 */

const goodLogic = 'https://prod-00.westus.logic.azure.com:443/workflows/0000/triggers/manual/paths/invoke?api-version=2016-06-01&sig=TESTSIGNOTREAL';
const goodPowerPlatform =
  'https://0000.environment.api.powerplatform.com/powerautomate/automations/direct/workflows/0000/triggers/manual/paths/invoke?api-version=1&sig=TESTSIGNOTREAL';

function codeOf(value: string): string {
  try {
    parseTeamsWebhookUrl(value);
    return 'accepted';
  } catch (error) {
    return error instanceof TeamsError ? error.code : 'unknown';
  }
}

describe('parseTeamsWebhookUrl', () => {
  it('accepts a public-cloud Workflows address, with and without an explicit :443', () => {
    expect(parseTeamsWebhookUrl(goodLogic).hostname).toBe('prod-00.westus.logic.azure.com');
    expect(
      parseTeamsWebhookUrl(
        'https://prod-00.westus.logic.azure.com/workflows/0000/triggers/manual/paths/invoke?api-version=2016-06-01&sig=TESTSIGNOTREAL',
      ).hostname,
    ).toBe('prod-00.westus.logic.azure.com');
  });

  it('accepts the newer and government host family', () => {
    expect(parseTeamsWebhookUrl(goodPowerPlatform).hostname).toBe(
      '0000.environment.api.powerplatform.com',
    );
  });

  it('refuses a host that merely contains our suffix', () => {
    // The attack the label-boundary comparison exists for: a domain the attacker
    // owns, with our suffix somewhere inside it.
    expect(codeOf('https://evillogic.azure.com.attacker.net/workflows/x')).toBe(
      'INVALID_WEBHOOK_URL',
    );
    expect(codeOf('https://logic.azure.com.evil/workflows/x')).toBe('INVALID_WEBHOOK_URL');
    // And the suffix on its own, with no label in front of it.
    expect(codeOf('https://logic.azure.com/workflows/x')).toBe('INVALID_WEBHOOK_URL');
  });

  it('refuses http, another port, and credentials in the URL', () => {
    expect(codeOf('http://prod-00.westus.logic.azure.com/workflows/x')).toBe(
      'INVALID_WEBHOOK_URL',
    );
    expect(codeOf('https://prod-00.westus.logic.azure.com:8443/workflows/x')).toBe(
      'INVALID_WEBHOOK_URL',
    );
    expect(codeOf('https://user:pass@prod-00.westus.logic.azure.com/workflows/x')).toBe(
      'INVALID_WEBHOOK_URL',
    );
  });

  it('refuses the right host with the wrong path', () => {
    // A real address on Microsoft's infrastructure that is not a Workflows
    // trigger would be accepted by a host-only check, and would fail on the
    // first alert instead of at configuration time.
    expect(codeOf('https://prod-00.westus.logic.azure.com/api/other')).toBe(
      'INVALID_WEBHOOK_URL',
    );
    expect(
      codeOf('https://0000.environment.api.powerplatform.com/workflows/x'),
    ).toBe('INVALID_WEBHOOK_URL');
  });

  it('gives the retired Office 365 connector its own explanation', () => {
    for (const legacy of [
      'https://outlook.office.com/webhook/abc',
      'https://outlook.office365.com/webhook/abc',
      'https://acme.webhook.office.com/webhookb2/abc',
    ]) {
      let message = '';
      try {
        parseTeamsWebhookUrl(legacy);
      } catch (error) {
        message = error instanceof TeamsError ? error.message : '';
        expect(error).toBeInstanceOf(TeamsError);
        expect((error as TeamsError).code).toBe('LEGACY_WEBHOOK_URL');
      }
      // The sentence has to say what happened and where the new address comes
      // from, or the reader has no next step.
      expect(message).toContain('switched off in May 2026');
      expect(message).toContain('Workflows');
    }
  });

  it('refuses an empty value and something that is not a URL at all', () => {
    expect(codeOf('')).toBe('INVALID_WEBHOOK_URL');
    expect(codeOf('not-a-url')).toBe('INVALID_WEBHOOK_URL');
  });
});

describe('maskTeamsWebhookUrl', () => {
  it('keeps the host and four characters of the path, and never the signature', async () => {
    const { encryptSensitive } = await import('../src/services/privacy.service.js');
    const masked = maskTeamsWebhookUrl(encryptSensitive(goodLogic));

    expect(masked).toContain('prod-00.westus.logic.azure.com');
    expect(masked).toContain('voke');
    expect(masked).not.toContain('TESTSIGNOTREAL');
    expect(masked).not.toContain('sig=');
  });
});

describe('buildTeamsCard', () => {
  const message = {
    subject: 'example.com: DMARC failure rate above 5%',
    body: 'Twelve messages failed DMARC in the last hour.',
    domainName: 'example.com',
    workspaceName: 'Northwind',
    risk: 'high' as const,
    linkPath: '/domains/example-com-abc123',
  };

  it('wraps an Adaptive Card in the envelope the Workflows template expects', () => {
    const card = buildTeamsCard({ message, appUrl: 'https://app.example.test' }) as {
      type: string;
      attachments: Array<{ contentType: string; contentUrl: null; content: Record<string, unknown> }>;
    };

    expect(card.type).toBe('message');
    expect(card.attachments).toHaveLength(1);
    expect(card.attachments[0]!.contentType).toBe('application/vnd.microsoft.card.adaptive');
    expect(card.attachments[0]!.contentUrl).toBeNull();
    expect(card.attachments[0]!.content.type).toBe('AdaptiveCard');
    expect(card.attachments[0]!.content.version).toBe('1.4');
  });

  it('puts customer-controlled text in a TextRun, so markdown is not parsed', () => {
    const hostile = {
      ...message,
      // This is text a customer controls, through a DNS record. A TextBlock would
      // render it as a link that says "click".
      body: 'TXT changed to [click](https://evil.example) at 12:00',
    };
    const card = buildTeamsCard({ message: hostile, appUrl: 'https://app.example.test' }) as {
      attachments: Array<{ content: { body: Array<Record<string, unknown>> } }>;
    };

    const rich = card.attachments[0]!.content.body.find((block) => block.type === 'RichTextBlock') as {
      inlines: Array<{ type: string; text: string }>;
    };

    expect(rich.inlines.every((run) => run.type === 'TextRun')).toBe(true);
    expect(rich.inlines.map((run) => run.text).join('')).toContain('[click](https://evil.example)');
    // And the hostile address is never a url anywhere in the card, which is what
    // it would have become if the body had been rendered as markdown.
    expect(JSON.stringify(card)).not.toContain('"url":"https://evil.example"');
  });

  it('carries Domain, Risk and Workspace as facts, and one button to the right page', () => {
    const card = buildTeamsCard({ message, appUrl: 'https://app.example.test' }) as {
      attachments: Array<{
        content: {
          body: Array<Record<string, unknown>>;
          actions: Array<{ type: string; title: string; url: string }>;
        };
      }>;
    };

    const facts = card.attachments[0]!.content.body.find((block) => block.type === 'FactSet') as {
      facts: Array<{ title: string; value: string }>;
    };

    expect(facts.facts.map((fact) => fact.title)).toEqual(['Domain', 'Risk', 'Workspace']);
    expect(facts.facts[1]!.value).toBe('High');
    expect(facts.facts[2]!.value).toBe('Northwind');

    const actions = card.attachments[0]!.content.actions;
    expect(actions).toHaveLength(1);
    expect(actions[0]!.type).toBe('Action.OpenUrl');
    expect(actions[0]!.url).toBe('https://app.example.test/domains/example-com-abc123');
  });

  it('omits the button when there is nowhere to send the reader', () => {
    const card = buildTeamsCard({
      message: { ...message, linkPath: '' },
      appUrl: '',
    }) as { attachments: Array<{ content: { actions: unknown[] } }> };

    expect(card.attachments[0]!.content.actions).toEqual([]);
  });

  it('keeps the whole message under Teams size limit, capping a long body', () => {
    const longBody = Array.from({ length: 400 }, (_, index) => `line ${index} of a very long summary`).join('\n');
    const card = buildTeamsCard({ message: { ...message, body: longBody }, appUrl: 'https://app.example.test' });

    const json = JSON.stringify(card);
    expect(json.length).toBeLessThan(20_000);

    const rich = (card as { attachments: Array<{ content: { body: Array<Record<string, unknown>> } }> })
      .attachments[0]!.content.body.find((block) => block.type === 'RichTextBlock') as {
      inlines: Array<{ text: string }>;
    };
    const text = rich.inlines.map((run) => run.text).join('');

    // Ten lines plus a count of the rest, as Slack's summary does.
    expect(text).toContain('and 390 more');
    expect(text.split('\n').filter((line) => line.startsWith('line ')).length).toBe(10);
  });

  it('cuts a body longer than the character cap', () => {
    const card = buildTeamsCard({
      message: { ...message, body: 'x'.repeat(5000) },
      appUrl: 'https://app.example.test',
    });

    const rich = (card as { attachments: Array<{ content: { body: Array<Record<string, unknown>> } }> })
      .attachments[0]!.content.body.find((block) => block.type === 'RichTextBlock') as {
      inlines: Array<{ text: string }>;
    };
    const body = rich.inlines.map((run) => run.text).join('');

    expect(body.length).toBeLessThanOrEqual(message.subject.length + 2 + 3000);
  });
});
