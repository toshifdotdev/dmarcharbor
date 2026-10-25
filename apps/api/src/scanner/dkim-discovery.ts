/**
 * Working out which DKIM selectors to look for.
 *
 * Why this exists
 * ---------------
 * A DKIM public key lives at `<selector>._domainkey.<domain>`, and the selector
 * is a label the sender chose freely. Nothing in DNS says what it is. So
 * answering "does this domain have DKIM configured" from DNS alone means
 * guessing labels, and the previous implementation guessed twelve of them and
 * reported "no common DKIM selector found" when it missed.
 *
 * That is a false negative on a domain with working DKIM, which is worse than
 * finding nothing at all: the customer is told they are broken when they are not.
 *
 * The useful signal
 * -----------------
 * The SPF record already tells us who sends for this domain. Every one of those
 * providers publishes DKIM keys, and each publishes the selector labels it uses.
 * So `include:_spf.google.com` means it is worth probing `google`, without
 * guessing. That converts evidence already in hand into an accurate answer, and
 * it is why this is a small change rather than a guessing project.
 *
 * What this deliberately does not do
 * ----------------------------------
 * It does not enumerate labels. Probing arbitrary strings against a customer's
 * domain at scale is reconnaissance, and it finds nothing useful: selector names
 * are unconstrained, so there is no prefix worth sweeping. Discovery is bounded
 * to what SPF evidence points at plus the documented conventions, and the cap is
 * enforced in the caller so the number is visible in the result rather than
 * implied.
 */

/**
 * Providers publish the labels they use. Keyed on the SPF include target, not on
 * the provider's brand name, because SPF is what actually names them.
 */
const PROVIDER_SELECTORS: Record<string, string[]> = {
  // Google Workspace
  '_spf.google.com': ['google'],
  'google.com': ['google'],
  // Microsoft 365 / Exchange Online
  '_spf.protection.outlook.com': ['selector1', 'selector2'],
  'spf.protection.outlook.com': ['selector1', 'selector2'],
  'outlook.com': ['selector1', 'selector2'],
  // Amazon SES
  'amazonses.com': ['amazonses'],
  '_spf.amazonses.com': ['amazonses'],
  // Mailgun, which publishes several selectors at once
  '_spf.mailgun.org': ['k1', 'k2', 'k3'],
  'mailgun.org': ['k1', 'k2', 'k3'],
  // Mailchimp
  '_spf.mailchimp.com': ['k1', 'k2', 'k3', 'k4'],
  'mailchimp.com': ['k1', 'k2', 'k3', 'k4'],
  // SendGrid
  '_spf.sendgrid.net': ['s1', 's2', 's3'],
  'sendgrid.net': ['s1', 's2', 's3'],
  // Postmark
  '_spf.postmarkapp.com': ['postmarkapp'],
  'postmarkapp.com': ['postmarkapp'],
  // Zendesk
  '_spf.zendesk.com': ['zendesk', 'zendesk2', 'zendesk3'],
  // Brevo / Sendinblue
  '_spf.brevo.com': ['brevo'],
  // Zoho
  'zoho.com': ['zoho'],
  'zohomail.com': ['zoho'],
  // Proofpoint
  '_spf.pphosted.com': ['pp1', 'pp2', 'pp3'],
  // Proofpoint and Mimecast shared egress patterns
  '_spf.mimecast.com': ['mta1', 'mta2', 'mta3'],
  // Salesforce
  '_spf.salesforce.com': ['sfi', 'sfs1', 'sfs2'],
  // Sophos
  '_spf.sophos.com': ['sophos1', 'sophos2', 'sophos3'],
  // Fastmail
  'spf.fastmail.com': ['fm1', 'fm2', 'fm3'],
  // Success.click
  '_spf.clicktime.net': ['ct1'],
};

/**
 * Labels worth trying when SPF says nothing useful.
 *
 * The floor, not the strategy. A domain that sends through a provider we have no
 * mapping for still gets checked against these.
 */
export const CONVENTION_SELECTORS: readonly string[] = [
  'default',
  'google',
  'selector1',
  'selector2',
  'k1',
  'k2',
  's1',
  's2',
  'resend',
  'sendgrid',
  'mailgun',
  'postmark',
  'amazonses',
];

/** How many DNS lookups one scan may spend on DKIM. */
export const DKIM_LOOKUP_BUDGET = 25;

/** The most selectors a previous scan may pin into the probe list. */
export const KNOWN_SELECTOR_LIMIT = 10;

/** A label has to be able to exist as a DNS label; anything else is wasted. */
function isSelectorLabel(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value);
}

export type SelectorSource = string;

/** Extracts the `include:` targets from an SPF record. */
export function spfIncludeTargets(spfRecord: string | null | undefined): string[] {
  if (!spfRecord) {
    return [];
  }

  const targets = new Set<string>();

  for (const match of spfRecord.matchAll(/include:([^\s]+)/gi)) {
    const value = match[1]?.trim().toLowerCase().replace(/\/.*$/, '');
    if (value) {
      targets.add(value);
    }
  }

  return [...targets];
}

export interface DkimCandidate {
  selector: string;
  /** Why this label is worth probing, shown so support can tell a guess from a fact. */
  source: SelectorSource;
}

/**
 * Builds the probe list, SPF-derived first so the budget is spent on the labels
 * most likely to be real.
 *
 * Deduplicated, because a domain with `include:_spf.google.com` would otherwise
 * probe `google` twice: once as evidence, once as a convention.
 */
export function dkimCandidates(spfRecord: string | null | undefined): DkimCandidate[] {
  const ordered: DkimCandidate[] = [];
  const seen = new Set<string>();

  const add = (selector: string, source: SelectorSource): void => {
    const label = selector.trim().toLowerCase();
    // A label that is not a bare DNS label cannot exist, so spending a lookup on
    // it is pure waste.
    if (!label || seen.has(label) || !isSelectorLabel(label)) {
      return;
    }
    seen.add(label);
    ordered.push({ selector: label, source });
  };

  for (const target of spfIncludeTargets(spfRecord)) {
    for (const selector of PROVIDER_SELECTORS[target] ?? []) {
      add(selector, `spf:${target}`);
    }
  }

  for (const selector of CONVENTION_SELECTORS) {
    add(selector, 'convention');
  }

  return ordered;
}

/** Applies the budget, reporting what was dropped so the result stays honest. */
export function budgetDkimCandidates(
  candidates: DkimCandidate[],
  budget = DKIM_LOOKUP_BUDGET,
): { selected: DkimCandidate[]; skipped: DkimCandidate[] } {
  return {
    selected: candidates.slice(0, budget),
    skipped: candidates.slice(budget),
  };
}

/**
 * Selectors a previous successful scan found.
 *
 * They are probed first and are never dropped by the budget. A selector that
 * existed yesterday but is left unprobed today would look removed, which is a
 * false alarm on a working key. The list is capped so a corrupted stored array
 * cannot turn one scan into an unbounded number of lookups.
 */
export function knownSelectorCandidates(selectors: readonly string[] | null | undefined): DkimCandidate[] {
  const ordered: DkimCandidate[] = [];
  const seen = new Set<string>();

  for (const selector of selectors ?? []) {
    if (ordered.length >= KNOWN_SELECTOR_LIMIT) break;
    const label = selector.trim().toLowerCase();
    if (!label || seen.has(label) || !isSelectorLabel(label)) continue;
    seen.add(label);
    ordered.push({ selector: label, source: 'previously found' });
  }

  return ordered;
}

/**
 * The full probe list: known selectors first, then the SPF-derived and
 * conventional candidates within what is left of the budget.
 */
export function buildDkimProbeList(
  spfRecord: string | null | undefined,
  knownSelectors: readonly string[] | null | undefined,
  budget = DKIM_LOOKUP_BUDGET,
): { selected: DkimCandidate[]; skipped: DkimCandidate[] } {
  const known = knownSelectorCandidates(knownSelectors);
  const seen = new Set(known.map((candidate) => candidate.selector));
  const derived = dkimCandidates(spfRecord).filter((candidate) => !seen.has(candidate.selector));
  const remaining = Math.max(0, budget - known.length);

  return {
    selected: [...known, ...derived.slice(0, remaining)],
    skipped: derived.slice(remaining),
  };
}