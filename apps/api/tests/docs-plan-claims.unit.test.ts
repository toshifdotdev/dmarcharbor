import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  activeDomainWindow,
  catalogOrder,
  entitlementLabels,
  isUnlimited,
  nextTier,
  planCatalog,
  planOrder,
  plannedEntitlements,
  quotaLabel,
  quotaLimitFor,
  type EntitlementKey,
  type PlanTierName,
  type QuotaKey,
} from '../src/services/entitlements/plan-catalog.js';
import {
  entitlementRefusalMessage,
  memberLimitDetails,
  memberLimitMessage,
  quotaUpgradeFor,
  quotaUpgradeSentence,
  requiredPlanFor,
} from '../src/services/entitlements/entitlement.service.js';
import { bulkLimits } from '../src/services/bulk-onboarding.service.js';
import { domainGraceDays } from '../src/services/inventory/inventory.service.js';

/**
 * The docs say what the plan catalogue says.
 *
 * docs/FAQ.md, GUIDE.md, API.md and the legal pages are read by people deciding
 * what to buy and by the in-app assistant (services/assistant/corpus.ts). Every
 * plan name, price, limit and "starts on" claim in them is checked here against
 * planCatalog and the functions that build the refusals, so changing a number in
 * the catalogue without the docs fails this file, in milliseconds, without CI.
 *
 * Each check finds its text by a stable anchor (a question, a heading, a table
 * header) and compares the numbers or plan names it finds there, rather than
 * whole paragraphs, so rewording a sentence does not fail it while changing a
 * fact does. Where a claim can only be pinned as a short fragment, the fragment
 * is built from the catalogue.
 */

const repoRoot = resolve(process.cwd(), '..', '..');
const docsDir = join(repoRoot, 'docs');
const read = (path: string): string => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
const doc = (file: string): string => read(join(docsDir, file));
const source = (path: string): string => read(join(process.cwd(), 'src', path));

const faq = doc('FAQ.md');
const guide = doc('GUIDE.md');
const api = doc('API.md');
const billing = doc('BILLING.md');

// ─── Reading the catalogue the way the docs write it ─────────────────────────

const label = (tier: PlanTierName): string => planCatalog[tier].label;
const planNames = catalogOrder.map(label);
const nameAlternation = planNames.join('|');

/** 1,000 and 3,650: the grouping the docs use for counts. */
const whole = (count: number): string => count.toLocaleString('en-US');

/** "$2.00" for a unit price, "$150" or "$2,000.25" for a total. */
function usd(minor: number, decimals: 'always' | 'when-needed'): string {
  const major = minor / 100;
  const digits = decimals === 'always' || !Number.isInteger(major) ? 2 : 0;
  return `$${major.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: 2 })}`;
}

/** "₹1,24,990": rupees are grouped the Indian way, as the pricing page prints them. */
function inr(minor: number): string {
  return `₹${(minor / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

/** "Harbor, Admiralty and Fleet". */
function joinAnd(items: string[]): string {
  return items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

const plansWith = (key: EntitlementKey): string[] =>
  catalogOrder.filter((tier) => planCatalog[tier].features[key]).map(label);

function firstPlanLabel(key: EntitlementKey): string {
  const tier = requiredPlanFor(key);
  expect(tier, `${key} is on no plan of the ladder, so no doc can say where it starts`).not.toBeNull();
  return label(tier!);
}

/** A Fleet band's range as the docs write it: "Up to 200", "201 to 500". */
function bandRange(index: number): string {
  const bands = planCatalog.FLEET.bands ?? [];
  const band = bands[index]!;
  return index === 0 ? `Up to ${whole(band.upTo)}` : `${whole(bands[index - 1]!.upTo + 1)} to ${whole(band.upTo)}`;
}

/** A default from config/env.ts, read as text so the test does not depend on the test run's environment. */
function envDefault(name: string): number {
  const match = source('config/env.ts').match(new RegExp(`\\b${name}:[^\\n]*?\\.default\\((\\d+)\\)`));
  expect(match, `${name} has no numeric default in src/config/env.ts`).not.toBeNull();
  return Number(match![1]);
}

/** A numeric constant declared in a source file, read as text. */
function sourceConstant(path: string, name: string): number {
  const match = source(path).match(new RegExp(`\\bconst ${name} = (\\d+);`));
  expect(match, `${name} is not a numeric constant in src/${path}`).not.toBeNull();
  return Number(match![1]);
}

// ─── Finding text by its anchor ──────────────────────────────────────────────

/** The answer under a bold question line, up to the next question or heading. */
function answer(text: string, question: string): string {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.trim() === `**${question}**`);
  expect(start, `"${question}" is no longer a question in the document`).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^\*\*[^*].*\*\*$/.test(line.trim()) || /^#{1,6}\s/.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

/** Every bold question in a document, with its answer. */
function questions(text: string): { question: string; text: string }[] {
  return text
    .split('\n')
    .map((line) => line.trim().match(/^\*\*([^*].*\?)\*\*$/)?.[1])
    .filter((question): question is string => Boolean(question))
    .map((question) => ({ question, text: answer(text, question) }));
}

/** The text under a heading, up to the next heading of the same level or higher, ignoring code. */
function section(text: string, heading: string): string {
  const level = heading.match(/^#+/)?.[0].length ?? 0;
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.trim() === heading);
  expect(start, `"${heading}" is no longer a heading in the document`).toBeGreaterThanOrEqual(0);
  let fenced = false;
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^```/.test(line)) fenced = !fenced;
    const hashes = fenced ? null : line.match(/^(#{1,6})\s/);
    if (hashes && hashes[1]!.length <= level) break;
    body.push(line);
  }
  return body.join('\n');
}

/** The cells of every table in a block of text: tables, rows, cells. The separator row is dropped. */
function tables(text: string): string[][][] {
  const found: string[][][] = [];
  let current: string[][] | null = null;
  for (const line of text.split('\n')) {
    if (!line.trim().startsWith('|')) {
      current = null;
      continue;
    }
    if (/^\|\s*:?-{3,}/.test(line.trim())) continue;
    const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
    if (!current) {
      current = [];
      found.push(current);
    }
    current.push(cells);
  }
  return found;
}

/** The table whose first header cell is `first`. */
function tableHeaded(text: string, first: string): string[][] {
  const table = tables(text).find((rows) => rows[0]?.[0] === first);
  expect(table, `no table headed "${first}"`).toBeDefined();
  return table!;
}

/** Every ```json block in a block of text, parsed. */
function jsonBlocks(text: string): Record<string, unknown>[] {
  return [...text.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) => JSON.parse(match[1]!) as Record<string, unknown>);
}

/** Text on one line, so a claim broken across a line wrap still reads as one. */
const flat = (text: string): string => text.replace(/\s+/g, ' ');

/** A fragment a long text must contain. Fails with the fragment, not the whole document. */
function expectSays(text: string, fragment: string, where: string): void {
  expect(text.includes(fragment), `${where} should say: ${fragment}`).toBe(true);
}

/**
 * The number each plan is given in a run of prose: "Mooring 2, Fairway 5",
 * "Fairway includes 10 a month, Harbor 50, Admiralty and Fleet 200".
 */
function numbersByPlan(text: string): Map<string, number> {
  const found = new Map<string, number>();
  const run = new RegExp(`((?:\\b(?:${nameAlternation})\\b(?:,\\s+|\\s+and\\s+)?)+)(?:\\s+includes)?\\s+(\\d[\\d,]*)\\b`, 'g');
  for (const match of flat(text).matchAll(run)) {
    for (const name of match[1]!.match(new RegExp(nameAlternation, 'g')) ?? []) {
      found.set(name, Number(match[2]!.replace(/,/g, '')));
    }
  }
  return found;
}

/** The plans a run of prose says have no limit: "Admiralty and Fleet have no limit". */
function noLimitPlans(text: string): string[] {
  const run = new RegExp(`((?:\\b(?:${nameAlternation})\\b(?:,\\s+|\\s+and\\s+)?)+)\\s+(?:have|has)\\s+no\\s+limit`, 'g');
  return [...flat(text).matchAll(run)].flatMap((match) => match[1]!.match(new RegExp(nameAlternation, 'g')) ?? []);
}

/** The plans named as where something starts: "Starts on Fairway", "from Harbor", "on Harbor and above". */
function plansNamedAsStart(text: string): string[] {
  const claim = new RegExp(`\\b(?:[Ss]tarts? on|[Ff]rom|[Oo]n)\\s+(${nameAlternation})\\b`, 'g');
  return [...new Set([...flat(text).matchAll(claim)].map((match) => match[1]!))].sort();
}

/** Team sizes, wherever a doc lists them in prose. */
function expectTeamSizes(text: string, where: string): void {
  const numbers = numbersByPlan(text);
  const unlimited = noLimitPlans(text);
  for (const tier of catalogOrder) {
    const { maxMembers } = planCatalog[tier];
    if (isUnlimited(maxMembers)) {
      expect(unlimited, `${where}: ${label(tier)} has no team-size limit`).toContain(label(tier));
      expect(numbers.has(label(tier)), `${where}: ${label(tier)} is given a number, but it has no limit`).toBe(false);
    } else {
      expect(numbers.get(label(tier)), `${where}: ${label(tier)} team size`).toBe(maxMembers);
      expect(unlimited, `${where}: ${label(tier)} is said to have no limit`).not.toContain(label(tier));
    }
  }
}

// ─── FAQ ─────────────────────────────────────────────────────────────────────

describe('FAQ: plans and limits', () => {
  it('lists every plan in the limits table, with every limit from the catalogue', () => {
    const table = tableHeaded(answer(faq, 'What are the limits on each plan?'), 'Limit');
    const [header, ...rows] = table;
    expect(header!.slice(1)).toEqual(planNames);

    const expected: Record<string, (tier: PlanTierName) => string> = {
      Clients: (tier) => whole(planCatalog[tier].maxClients),
      'Active domains': (tier) => whole(planCatalog[tier].maxActiveDomains),
      'Team members per workspace': (tier) =>
        isUnlimited(planCatalog[tier].maxMembers) ? 'No limit' : whole(planCatalog[tier].maxMembers),
      'Workspaces per account': (tier) => whole(planCatalog[tier].maxWorkspaces),
      'Prospect reports a month': (tier) =>
        planCatalog[tier].maxProspectReportsPerMonth > 0 ? whole(planCatalog[tier].maxProspectReportsPerMonth) : 'None',
    };
    expect(rows.map((row) => row[0])).toEqual(Object.keys(expected));
    for (const row of rows) {
      expect(row.slice(1), `the FAQ's "${row[0]}" row`).toEqual(catalogOrder.map(expected[row[0]!]!));
    }
  });

  it('states each team size', () => {
    expectTeamSizes(answer(faq, 'How many people can join a workspace?'), 'FAQ team size');
  });

  it('states each prospect allowance, and none on a plan without the feature', () => {
    const numbers = numbersByPlan(answer(faq, 'What is a prospect report?'));
    for (const tier of catalogOrder) {
      const allowance = planCatalog[tier].maxProspectReportsPerMonth;
      expect(numbers.get(label(tier)), `FAQ prospect allowance on ${label(tier)}`).toBe(allowance > 0 ? allowance : undefined);
    }
  });

  it('says in "What starts on which plan?" what each plan adds in prospects and team size, and that the free plan has only the always-on features', () => {
    const text = answer(faq, 'What starts on which plan?');
    const bullets = new Map<string, string>();
    let name: string | null = null;
    for (const line of text.split('\n')) {
      const opener = line.match(/^- \*\*(.+?):\*\*/);
      if (opener) {
        name = opener[1] === 'Every plan, free included' ? label('MOORING') : opener[1]!;
        bullets.set(name, '');
      }
      if (name) bullets.set(name, `${bullets.get(name)} ${line}`);
    }
    expect([...bullets.keys()]).toEqual(planNames);

    for (const tier of catalogOrder) {
      const bullet = flat(bullets.get(label(tier))!);
      const allowance = planCatalog[tier].maxProspectReportsPerMonth;
      if (allowance > 0) expect(bullet, label(tier)).toContain(`${whole(allowance)} prospect reports a month`);
      else expect(bullet, label(tier)).not.toMatch(/prospect reports a month/);
      expect(bullet.includes('an unlimited team'), `${label(tier)}: "an unlimited team"`).toBe(isUnlimited(planCatalog[tier].maxMembers));
    }

    // Fleet is Harbor's features: the two Admiralty keys are the ones it lacks.
    for (const key of ['branding.customDomain', 'auth.sso'] as const) {
      expect(planCatalog.FLEET.features[key], key).toBe(false);
      expect(firstPlanLabel(key), key).toBe(label('ADMIRALTY'));
    }
    expect(flat(bullets.get(label('FLEET'))!)).toContain(`Your own domain and single sign-on stay on ${label('ADMIRALTY')}`);

    // The bullet names aggregate reports, the audit trail, export and erasure.
    // Anything else the free plan gains has to be added to it.
    const freeKeys = (Object.keys(entitlementLabels) as EntitlementKey[]).filter((key) => planCatalog.MOORING.features[key]);
    expect(freeKeys.sort()).toEqual(['audit.trail', 'data.erase', 'data.export', 'reports.aggregate']);
  });

  it('counts a domain the way countCountedDomainsIn does, the same on every plan', () => {
    const text = flat(answer(faq, 'How are the limits counted?'));
    expect(text).toContain(`for its first ${domainGraceDays} days`);
    // One window for every plan. If the catalogue ever gives plans different
    // windows again, this fails and the FAQ needs a sentence per plan.
    const windows = new Set(catalogOrder.map((tier) => planCatalog[tier].activeDomainWindowDays));
    expect([...windows], 'the active-domain window differs between plans').toEqual([activeDomainWindow]);
    expect(text).toContain(`sent a report in the last ${activeDomainWindow} days. That is the same on every plan.`);
    expect(text).toContain(`stops counting ${activeDomainWindow} days after its last report`);
    // The guide says the same.
    expect(flat(guide)).toContain(`stops counting ${activeDomainWindow} days after its last report`);
    // And the window is shorter than report retention, so a domain can always
    // be counted by a report that still exists.
    expect(activeDomainWindow).toBeLessThanOrEqual(envDefault('REPORT_RETENTION_DAYS'));
  });

  it('prices Fleet band by band as the catalogue bills it', () => {
    const text = answer(faq, 'How is Fleet priced?');
    const [, ...rows] = tableHeaded(text, 'Active domains');
    const bands = planCatalog.FLEET.bands ?? [];
    expect(rows).toHaveLength(bands.length);
    bands.forEach((band, index) => {
      expect(rows[index], `FAQ Fleet band ${index + 1}`).toEqual([
        bandRange(index),
        `${usd(band.unitMinor.USD, 'always')} (${inr(band.unitMinor.INR)})`,
        `${usd(band.unitMinor.USD * band.minimumQuantity, 'when-needed')} (${inr(band.unitMinor.INR * band.minimumQuantity)}), covering up to ${whole(band.minimumQuantity)}`,
      ]);
    });

    // "From 200 to 300 domains Admiralty costs about the same and adds your own
    // domain and single sign-on": within 5% at every count in that range, and
    // only Admiralty has the two.
    const admiralty = planCatalog.ADMIRALTY;
    expect(flat(text)).toContain(`From ${whole(bands[0]!.upTo)} to ${whole(admiralty.maxActiveDomains)} domains ${admiralty.label} costs about the same`);
    for (let count = bands[0]!.upTo; count <= admiralty.maxActiveDomains; count += 1) {
      const band = bands.find((entry) => count <= entry.upTo)!;
      const fleetBill = band.unitMinor.USD * Math.max(count, band.minimumQuantity);
      expect(Math.abs(fleetBill - admiralty.prices.USD.monthlyMinor) / admiralty.prices.USD.monthlyMinor, `${count} domains`).toBeLessThanOrEqual(0.05);
    }
    for (const key of ['branding.customDomain', 'auth.sso'] as const) {
      expect(admiralty.features[key]).toBe(true);
      expect(planCatalog.FLEET.features[key]).toBe(false);
    }
  });

  it('names every limit the downgrade guard checks', () => {
    // The quotas planOverageFor counts, read from the guard itself.
    const guard = source('billing/checkout.service.ts').match(/async function planOverageFor[\s\S]*?return counted/)?.[0] ?? '';
    const quotas = [...guard.matchAll(/quota: '(\w+)'/g)].map((match) => match[1]!);
    expect(quotas).toEqual(expect.arrayContaining(['client', 'activeDomain', 'member', 'workspace']));
    const words: Record<string, string> = { client: 'clients', activeDomain: 'active domains', member: 'team members', workspace: 'workspaces' };
    const faqAnswer = flat(answer(faq, 'Can I downgrade below what I am using?'));
    const billingGuard = flat(billing);
    for (const quota of quotas) {
      expect(words[quota], `a new quota in the downgrade guard (${quota}) needs words here`).toBeDefined();
      expect(faqAnswer, `FAQ downgrade answer: ${quota}`).toContain(words[quota]!);
      expect(
        new RegExp(`PLAN_CHANGE_OVER_QUOTA[\\s\\S]*${words[quota]}`).test(billingGuard),
        `docs/BILLING.md should name ${words[quota]} among the limits a plan change is refused for`,
      ).toBe(true);
    }
  });
});

/**
 * Every FAQ answer that says where a feature starts, and the features it is about.
 * The plans it names must be the plans the catalogue starts those features on.
 */
const faqFeatureAnswers: Record<string, EntitlementKey[]> = {
  'What if I use Cloudflare?': ['dns.automation'],
  'What are senders, and what should I do with them?': ['senders.owners'],
  'How do alerts work?': ['alerts.email', 'alerts.spoofing'],
  'Does it watch DNS?': ['alerts.email'],
  'Does it warn me before a domain registration expires?': ['alerts.email'],
  'Can alerts open tickets in my PSA?': ['integrations.psa'],
  'Can I get events in my own systems?': ['integrations.webhooks'],
  'What is hosted DMARC?': ['dns.hosted'],
  'Can my client approve enforcement?': ['portal.client'],
  "What about SPF's 10-lookup limit?": ['dns.managedSpf'],
  'Can you tell me which SPF includes are no longer used?': ['dns.spfUsage'],
  'Do you support BIMI and MTA-STS?': ['dns.hostedBimi', 'dns.hostedMtaSts', 'reports.tlsrpt'],
  'Can my clients see their own data?': ['portal.client'],
  'Can I share a report without giving portal access?': ['sharing.links'],
  'What are digests and monthly reports?': ['digests', 'reports.compliancePack'],
  'What is a compliance pack?': ['reports.compliancePack'],
  'What is a Trust Center?': ['trust.center'],
  'Can I use my own brand?': ['branding.whitelabel', 'branding.customDomain'],
  'Do you support single sign-on?': ['auth.sso'],
  'What about forensic reports and personal data?': ['reports.forensicNamed'],
  'How do I bill my clients for what they used?': ['reports.usageExport'],
  'Is there an API?': ['api.access'],
  'Can I ask questions inside the app?': ['assistant.docs'],
};

/**
 * Answers that name a plan for another reason (a limit, a downgrade), or that
 * have a test of their own ("What starts on which plan?", above).
 */
const faqPlanMentionsThatAreNotStarts = new Set([
  'What starts on which plan?',
  'How are the limits counted?',
  'What happens to features when I downgrade?',
  'What happens to single sign-on if we leave Admiralty?',
]);

describe('FAQ: where each feature starts', () => {
  it.each(Object.entries(faqFeatureAnswers))('"%s" names the plan the catalogue starts it on', (question, keys) => {
    const named = plansNamedAsStart(answer(faq, question));
    const expected = [...new Set(keys.map(firstPlanLabel))].sort();
    expect(named, `"${question}" should say ${expected.join(' and ')}`).toEqual(expected);
  });

  it('lists every plan with Ask', () => {
    expect(flat(answer(faq, 'Can I ask questions inside the app?'))).toContain(`Yes, on ${joinAnd(plansWith('assistant.docs'))}.`);
  });

  it('pins every answer that says where something starts', () => {
    const unpinned = questions(faq)
      .filter(({ question }) => !(question in faqFeatureAnswers) && !faqPlanMentionsThatAreNotStarts.has(question))
      .filter(({ text }) => plansNamedAsStart(text).length > 0)
      .map(({ question }) => question);
    expect(unpinned, 'Add these to faqFeatureAnswers with the entitlement keys they describe').toEqual([]);
  });
});

describe('FAQ: limits that are the same on every plan', () => {
  it('states the retention windows the deployment defaults to', () => {
    const text = flat(answer(faq, 'How long do you keep my data?'));
    expect(text).toContain(`aggregate and TLS reports for ${envDefault('REPORT_RETENTION_DAYS')} days`);
    expect(text).toContain(`forensic reports for ${envDefault('FORENSIC_RETENTION_DAYS')} days`);
    expect(text).toContain(`named recipient details for ${envDefault('FORENSIC_PII_RETENTION_DAYS')} days`);
    expect(text).toContain(`downloaded for ${envDefault('EXPORT_JOB_RETENTION_DAYS')} days`);
  });

  it('states the assistant limits and how long an unanswered question is kept', () => {
    const text = flat(answer(faq, 'Can I ask questions inside the app?'));
    expect(text).toContain(
      `ask ${envDefault('ASSISTANT_RATE_LIMIT_PER_MINUTE')} questions a minute, and a workspace ${envDefault('ASSISTANT_WORKSPACE_DAILY_LIMIT')} a day`,
    );
    expect(text).toContain(`kept for ${envDefault('ASSISTANT_QUESTION_RETENTION_DAYS')} days`);
  });

  it('states the Cloudflare connection, digest recipient and bulk import caps', () => {
    expect(flat(answer(faq, 'What if I use Cloudflare?'))).toContain(
      `up to ${sourceConstant('services/dns-automation/connections.service.ts', 'maxDnsConnections')} Cloudflare connections`,
    );
    expect(flat(answer(faq, 'What are digests and monthly reports?'))).toContain(
      `up to ${sourceConstant('services/report-digest.service.ts', 'maximumRecipients')} addresses`,
    );
    const bulk = flat(answer(faq, 'Can I add many domains at once?'));
    expect(bulk).toContain(`up to ${bulkLimits.maxDomains} domains on a client's page`);
    expect(bulk).toContain(`up to ${bulkLimits.maxClients} clients or ${bulkLimits.maxDomains} domains a request`);
  });

  it('gives existing members of a downgraded SSO workspace the grace the code gives', () => {
    const grace = sourceConstant('services/entitlements/plan-change-effects.ts', 'SSO_DOWNGRADE_GRACE_DAYS');
    expect(flat(answer(faq, 'What happens to single sign-on if we leave Admiralty?'))).toContain(`for ${grace} days`);
    expect(flat(answer(faq, 'What happens to features when I downgrade?'))).toContain(`existing members get ${grace} days`);
  });
});

// ─── Setup guide ─────────────────────────────────────────────────────────────

/** Each plan claim in the guide, as a fragment built from the catalogue. */
function guideClaims(): { claim: string; keys: EntitlementKey[] }[] {
  const above = (key: EntitlementKey) => `${firstPlanLabel(key)} and above`;
  return [
    { claim: `**Publish through Cloudflare** (${above('dns.automation')})`, keys: ['dns.automation'] },
    { claim: `**Host the DMARC record** (${above('dns.hosted')})`, keys: ['dns.hosted'] },
    { claim: `On ${above('senders.owners')}, name an owner for each sender`, keys: ['senders.owners'] },
    { claim: `managed SPF (${above('dns.managedSpf')})`, keys: ['dns.managedSpf'] },
    { claim: `To tidy SPF (${above('dns.spfUsage')})`, keys: ['dns.spfUsage'] },
    { claim: `**Alerts** (${above('alerts.email')})`, keys: ['alerts.email'] },
    { claim: `**Slack and Teams** (${above('alerts.email')})`, keys: ['alerts.email'] },
    { claim: `**PSA tickets** (${above('integrations.psa')})`, keys: ['integrations.psa'] },
    { claim: `**Webhooks** (${above('integrations.webhooks')})`, keys: ['integrations.webhooks'] },
    { claim: `${above('alerts.email')} send warnings about both`, keys: ['alerts.email'] },
    { claim: `On ${firstPlanLabel('auth.sso')} you can connect SAML or OIDC single sign-on`, keys: ['auth.sso'] },
    { claim: `**Client portal** (${above('portal.client')})`, keys: ['portal.client'] },
    { claim: `**Share links** (${above('sharing.links')})`, keys: ['sharing.links'] },
    { claim: `**Digests and monthly reports** (${above('digests')})`, keys: ['digests', 'reports.compliancePack'] },
    { claim: `**Usage for billing** (${above('reports.usageExport')})`, keys: ['reports.usageExport'] },
    { claim: `**Trust Center and compliance pack** (${above('trust.center')})`, keys: ['trust.center', 'reports.compliancePack'] },
    { claim: `**Your brand** (${above('branding.whitelabel')})`, keys: ['branding.whitelabel'] },
    { claim: `On ${firstPlanLabel('branding.customDomain')}, add your own domain`, keys: ['branding.customDomain'] },
    { claim: `${firstPlanLabel('branding.customDomain')} can also send client emails from your own address`, keys: ['branding.customDomain'] },
    { claim: `To have the client approve first (${above('portal.client')})`, keys: ['portal.client'] },
    { claim: `**TLS reports** (${above('reports.tlsrpt')})`, keys: ['reports.tlsrpt'] },
    { claim: `**MTA-STS** (${above('dns.hostedMtaSts')})`, keys: ['dns.hostedMtaSts'] },
    { claim: `**BIMI** (${above('dns.hostedBimi')})`, keys: ['dns.hostedBimi'] },
    { claim: `Under Prospects (${above('prospects.reports')})`, keys: ['prospects.reports'] },
  ];
}

describe('Setup guide', () => {
  const text = flat(guide);

  it.each(guideClaims().map((entry) => [entry.claim, entry] as const))('says "%s"', (_claim, entry) => {
    // A claim that pairs two features is only true while both start together.
    expect(new Set(entry.keys.map(firstPlanLabel)).size, `${entry.keys.join(' and ')} no longer start on the same plan`).toBe(1);
    // A boolean, so a failure prints the claim rather than the whole guide.
    expect(text.includes(entry.claim), `docs/GUIDE.md should say: ${entry.claim}`).toBe(true);
  });

  it('pins every "X and above" in the guide', () => {
    const ranges = guideClaims()
      .map(({ claim }) => [text.indexOf(claim), text.indexOf(claim) + claim.length] as const)
      .filter(([start]) => start >= 0);
    // Quoted phrases explain the convention ("Harbor and above" includes Fleet); they claim nothing.
    const unquoted = text.replace(/"[^"]*"/g, (quoted) => ' '.repeat(quoted.length));
    const loose = [...unquoted.matchAll(new RegExp(`\\b(?:${nameAlternation}) and above\\b`, 'g'))]
      .filter((match) => !ranges.some(([start, end]) => match.index! >= start && match.index! < end))
      .map((match) => text.slice(Math.max(0, match.index! - 40), match.index! + 30));
    expect(loose, 'Add these to guideClaims with the entitlement keys they describe').toEqual([]);
  });

  it('says that "and above" includes Fleet, which holds while Fleet has every Harbor feature', () => {
    expectSays(text, 'Fleet has everything Harbor has', 'docs/GUIDE.md');
    for (const key of Object.keys(entitlementLabels) as EntitlementKey[]) {
      if (planCatalog.HARBOR.features[key]) expect(planCatalog.FLEET.features[key], key).toBe(true);
    }
  });

  it('states each team size', () => {
    expectTeamSizes(section(guide, '## 6. Bring in your team'), 'GUIDE team size');
  });
});

// ─── API reference ───────────────────────────────────────────────────────────

describe('API reference', () => {
  const gates = section(api, '## Plan gates');

  it('lists, for each gated route, exactly the plans that include its feature', () => {
    const [header, ...rows] = tableHeaded(gates, 'Feature');
    expect(header).toEqual(['Feature', 'Routes', 'Included on']);
    expect(rows.length).toBeGreaterThan(0);
    for (const [cell, , included] of rows) {
      const key = cell!.replace(/`/g, '') as EntitlementKey;
      expect(key in entitlementLabels, `${key} is not an entitlement`).toBe(true);
      expect(plannedEntitlements).not.toContain(key);
      const plans = included!.split(', ');
      expect(plans, `the plans API.md lists for ${key}`).toEqual(plansWith(key));
      expect(plans[0], `the first plan with ${key}`).toBe(firstPlanLabel(key));
    }
  });

  it('names the plans with the API, and keeps "includes the other three" true', () => {
    expectSays(flat(gates), `The API is included on ${joinAnd(plansWith('api.access'))} (the \`api.access\` feature)`, 'API.md, Plan gates');
    const keys = tableHeaded(gates, 'Feature')
      .slice(1)
      .map((row) => row[0]!.replace(/`/g, '') as EntitlementKey);
    expectSays(flat(gates), `includes the other ${['one', 'two', 'three', 'four', 'five'][keys.length - 2]} today`, 'API.md, Plan gates');
    for (const tier of catalogOrder.filter((entry) => planCatalog[entry].features['api.access'])) {
      for (const key of keys) expect(planCatalog[tier].features[key], `${label(tier)} has the API but not ${key}`).toBe(true);
    }
  });

  it('gives every endpoint a feature that the plan gates table explains', () => {
    const gated = new Set(tableHeaded(gates, 'Feature').slice(1).map((row) => row[0]!));
    const [, ...rows] = tableHeaded(api, 'Method and path');
    for (const row of rows) expect(gated, `${row[0]} needs ${row[2]}`).toContain(row[2]);
  });

  it('shows GET /me answering with the example plan exactly as the catalogue grants it', () => {
    const [me] = jsonBlocks(section(api, '### GET /api/v1/me')) as Array<{
      plan: { tier: PlanTierName; label: string };
      features: Record<string, boolean>;
      limits: Record<string, number | null>;
    }>;
    const plan = planCatalog[me!.plan.tier];
    expect(me!.plan.label).toBe(plan.label);
    expect(me!.features).toEqual({ ...plan.features });
    expect(me!.limits).toEqual({
      maxClients: plan.maxClients,
      maxActiveDomains: plan.maxActiveDomains,
      maxMembers: isUnlimited(plan.maxMembers) ? null : plan.maxMembers,
    });
  });

  it('shows a feature refusal the way entitlementRefusalMessage writes it', () => {
    const refusal = jsonBlocks(section(api, '## Errors'))
      .map((block) => block.error as Record<string, string>)
      .find((error) => error?.code === 'FEATURE_NOT_IN_PLAN')!;
    const feature = refusal.feature as EntitlementKey;
    const tier = refusal.plan as PlanTierName;
    expect(planCatalog[tier].features[feature], `${tier} has ${feature}, so it would not be refused`).toBe(false);
    expect(refusal.message).toBe(entitlementRefusalMessage(feature, label(tier)));
    expect(refusal.planLabel).toBe(label(tier));
    expect(refusal.requiredIn).toBe(requiredPlanFor(feature));
    expect(refusal.upgradeTo).toBe(nextTier(tier));
  });

  it('shows a quota refusal the way quotaExceeded writes it', () => {
    const refusal = jsonBlocks(section(api, '## Errors'))
      .map((block) => block.error as Record<string, string | number | null>)
      .find((error) => error?.code === 'PLAN_LIMIT_REACHED')!;
    const tier = refusal.plan as PlanTierName;
    const quota = refusal.quota as QuotaKey;
    const limit = quotaLimitFor(tier, quota);
    expect(refusal.limit).toBe(limit);
    expect(refusal.used).toBe(limit);
    expect(refusal.label).toBe(quotaLabel(quota));
    expect(refusal.planLabel).toBe(label(tier));
    expect(refusal.upgradeTo).toBe(quotaUpgradeFor(tier, quota));
    expect(refusal.upgradeToLabel).toBe(refusal.upgradeTo ? label(refusal.upgradeTo as PlanTierName) : null);
    expect(refusal.message).toBe(`${label(tier)} includes ${limit} ${quotaLabel(quota)} and you have ${limit}. ${quotaUpgradeSentence(tier, quota)}`);
  });

  it('shows an invitation refusal the way memberLimitMessage and memberLimitDetails write it', () => {
    const [refusal] = jsonBlocks(section(api, '### Plan refusals from the app')) as Array<Record<string, unknown>>;
    const tier = refusal!.plan as PlanTierName;
    const allowance = {
      limit: planCatalog[tier].maxMembers,
      members: refusal!.members as number,
      pending: refusal!.pending as number,
      plan: tier,
      planLabel: label(tier),
    };
    expect(allowance.members + allowance.pending, 'the example must be a full team').toBeGreaterThanOrEqual(allowance.limit);
    expect(refusal!.message).toBe(memberLimitMessage(allowance));
    expect(refusal).toMatchObject(memberLimitDetails(allowance));
  });

  it('shows bulk rejections that end with the upgrade the import writes', () => {
    const [bulk] = jsonBlocks(section(api, '### POST /api/v1/clients/bulk')) as Array<{
      planLimitRejections: { quota: QuotaKey; reason: string }[];
      limits: unknown;
    }>;
    expect(bulk!.limits).toEqual(bulkLimits);
    expect(bulk!.planLimitRejections.length).toBeGreaterThan(0);
    for (const rejection of bulk!.planLimitRejections) {
      const tier = catalogOrder.find((entry) => rejection.reason.startsWith(`${label(entry)} includes `))!;
      expect(tier, rejection.reason).toBeDefined();
      expect(rejection.reason).toMatch(new RegExp(`^${label(tier)} includes ${quotaLimitFor(tier, rejection.quota)} ${quotaLabel(rejection.quota)} `));
      expect(rejection.reason.endsWith(quotaUpgradeSentence(tier, rejection.quota)), rejection.reason).toBe(true);
    }
    const [domains] = jsonBlocks(section(api, '### POST /api/v1/domains/bulk')) as Array<{ limits: unknown }>;
    expect(domains!.limits).toEqual(bulkLimits);
  });

  it('states the bulk caps from bulkLimits', () => {
    const text = flat(api);
    expectSays(text, `At most ${bulkLimits.maxClients} clients per request`, 'docs/API.md');
    expectSays(text, `At most ${bulkLimits.maxDomains} domains per request`, 'docs/API.md');
    expectSays(text, `Create up to ${bulkLimits.maxClients} clients in one call`, 'docs/API.md');
    expectSays(text, `Add up to ${bulkLimits.maxDomains} domains to one client`, 'docs/API.md');
    expectSays(flat(gates), `(${bulkLimits.maxClients} clients or ${bulkLimits.maxDomains} domains)`, 'API.md, Plan gates');
  });

  it('shows entitlement.exceeded with the limit and upgrade the catalogue gives', () => {
    const [event] = jsonBlocks(section(api, '### `entitlement.exceeded`')) as Array<Record<string, unknown>>;
    const tier = event!.plan as PlanTierName;
    const quota = event!.quota as QuotaKey;
    expect(event!.limit).toBe(quotaLimitFor(tier, quota));
    expect(event!.planLabel).toBe(label(tier));
    expect(event!.upgradeTo).toBe(quotaUpgradeFor(tier, quota));
  });

  it('states the per-key rate limit the deployment defaults to', () => {
    expectSays(api, `| Per key | API key | ${envDefault('API_RATE_LIMIT_PER_MINUTE')} a minute |`, 'docs/API.md');
    expectSays(api, `| Scans | Your server's IP address | ${envDefault('SCAN_RATE_LIMIT_PER_MINUTE')} a minute |`, 'docs/API.md');
  });
});

// ─── Billing ─────────────────────────────────────────────────────────────────

describe('Billing reference', () => {
  const prices = section(billing, '## Plans and prices');

  it('prices every flat plan monthly and annually, in both currencies', () => {
    const [header, ...rows] = tableHeaded(prices, 'Plan');
    expect(header).toEqual(['Plan', 'USD a month', 'INR a month', 'USD a year', 'INR a year']);
    const flatPlans = planOrder.filter((tier) => planCatalog[tier].pricing === 'flat');
    expect(rows.map((row) => row[0])).toEqual(flatPlans.map(label));
    for (const tier of flatPlans) {
      const { USD, INR } = planCatalog[tier].prices;
      expect(rows.find((row) => row[0] === label(tier)), `BILLING.md ${label(tier)} prices`).toEqual([
        label(tier),
        usd(USD.monthlyMinor, 'when-needed'),
        inr(INR.monthlyMinor),
        usd(USD.annualMinor, 'when-needed'),
        inr(INR.annualMinor),
      ]);
    }
  });

  it('keeps "ten months of price for twelve months of service" true', () => {
    expectSays(flat(prices), 'Annual billing is ten months of price for twelve months of service', 'docs/BILLING.md');
    for (const tier of planOrder) {
      for (const price of Object.values(planCatalog[tier].prices)) expect(price.annualMinor, label(tier)).toBe(price.monthlyMinor * 10);
    }
  });

  it('lists every Fleet band with its unit prices and minimum', () => {
    const [, ...rows] = tableHeaded(prices, 'Fleet band');
    const bands = planCatalog.FLEET.bands ?? [];
    expect(rows).toHaveLength(bands.length);
    bands.forEach((band, index) => {
      expect(rows[index], `BILLING.md Fleet band ${index + 1}`).toEqual([
        bandRange(index),
        usd(band.unitMinor.USD, 'always'),
        inr(band.unitMinor.INR),
        whole(band.minimumQuantity),
      ]);
    });
    expect(bands[0]!.minimumQuantity).toBe(planCatalog.FLEET.minimumQuantity);
  });

  it('says Fleet is monthly only and counts what the quota counts', () => {
    expect(planCatalog.FLEET.intervals).toEqual(['monthly']);
    const text = flat(prices);
    expectSays(text, 'Fleet is billed monthly per active domain, in bands, and has no annual price', 'docs/BILLING.md');
    expectSays(
      text,
      `sent a report in the last ${planCatalog.FLEET.activeDomainWindowDays} days or was added in the last ${domainGraceDays}`,
      'docs/BILLING.md',
    );
  });
});

// ─── Every document ──────────────────────────────────────────────────────────

const allDocs = readdirSync(docsDir)
  .filter((file) => file.endsWith('.md'))
  .map((file) => ({ file, text: doc(file) }));

describe('every document', () => {
  it('reads the docs folder', () => {
    expect(allDocs.map(({ file }) => file)).toEqual(expect.arrayContaining(['FAQ.md', 'GUIDE.md', 'API.md', 'BILLING.md']));
  });

  it('never offers staged policy rollout, which is planned and not built', () => {
    const offered = allDocs.flatMap(({ file, text }) =>
      text
        .split('\n')
        .map((line, index) => ({ line, at: `${file}:${index + 1}` }))
        .filter(({ line }) => /canary|staged (policy )?rollout|rollout stages?/i.test(line))
        .filter(({ line }) => !/"rollout\.canary":\s*false|not built|not sold|not offered|not yet available/i.test(line))
        .map(({ at, line }) => `${at} ${line.trim()}`),
    );
    expect(offered).toEqual([]);
    for (const key of plannedEntitlements) {
      for (const tier of catalogOrder) expect(planCatalog[tier].features[key], `${key} on ${tier}`).toBe(false);
    }
  });

  it('never says retention depends on the plan', () => {
    const claims = allDocs.flatMap(({ file, text }) =>
      text
        .split('\n')
        .filter((line) => /retain|retention|kept|keep/i.test(line) && /\b(by plan|varies by plan|depends (partly )?on (the )?[\w' ]*plan|on the (default|highest) plan)\b/i.test(line))
        .map((line) => `${file}: ${line.trim()}`),
    );
    expect(claims).toEqual([]);
  });

  it('never says clients or domains are counted per workspace', () => {
    const claims = allDocs.flatMap(({ file, text }) =>
      flat(text)
        .split(/[.;]/)
        .filter((sentence) => /\b(clients|active domains|limits)\b[^.;]*\b(are|is) (counted )?per workspace\b/i.test(sentence))
        .map((sentence) => `${file}: ${sentence.trim()}`),
    );
    expect(claims).toEqual([]);
  });
});

// ─── The pricing page's own copy ─────────────────────────────────────────────

describe('pricing page copy', () => {
  it('names Admiralty’s domain limit where it sends a Fleet buyer to Admiralty', () => {
    const board = flat(read(join(repoRoot, 'apps/web/components/harbor/pricing-board.tsx')));
    const admiralty = planCatalog.ADMIRALTY;
    const where = 'apps/web/components/harbor/pricing-board.tsx';
    expectSays(board, `Up to ${admiralty.maxActiveDomains} domains, ${admiralty.label} includes your own domain and SSO`, where);
    expectSays(board, `for more than ${admiralty.maxActiveDomains} domains`, where);
  });
});
