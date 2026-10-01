/**
 * DMARC alignment, per RFC 7489 section 3.1.1.
 *
 * Why this needed writing
 * -----------------------
 * The parser previously decided alignment by exact string equality, so a sender
 * authenticating as `mail.acme.com` was scored as unaligned against a policy
 * domain of `acme.com`. Almost every real deployment signs on a subdomain, which
 * meant legitimate senders were reported as unattributed, which meant the
 * spoofing detector fired on them, which meant a false breach alert landed in a
 * customer's inbox and buried the real one.
 *
 * The two modes
 * -------------
 * Strict   the authenticating domain must be exactly the policy domain.
 * Relaxed  the authenticating domain must share an organisational domain with
 *          it, which is the public suffix plus one label.
 *
 * The mode is not a choice we make. RFC 7489 has the policy domain declare it,
 * through the `aspf` tag for SPF and `adkim` for DKIM. We already parse and
 * store both, so this honours them rather than assuming relaxed for everything.
 * A domain published with `aspf=s` is explicitly asking for strict, and quietly
 * ignoring that would weaken a control the customer deliberately chose.
 *
 * The public suffix problem
 * -------------------------
 * Naive relaxed matching, "is one domain a suffix of the other", is wrong in a
 * way that matters. If `user.github.io` were relaxed-aligned with
 * `someone-elses-account.github.io`, then every GitHub Pages customer would be
 * relaxed-aligned with every other, and an attacker with one Pages account could
 * send as any other. That is why alignment is defined on *organisational*
 * domains rather than on substring overlap.
 *
 * Doing that properly needs the Public Suffix List, which is a data file several
 * hundred kilobytes wide that goes stale and needs shipping. This uses a curated
 * set of multi-tenant suffixes plus the common second-level ones, which covers the
 * hosting platforms where this mistake is actually made, at a size that costs
 * nothing to keep correct. The failure mode if the list is ever missing an entry
 * is conservative: the two domains compare as different organisations and the
 * sender is marked unaligned, which is the direction that produces a false
 * "check this" rather than a missed attack.
 */

/** How a domain published its own alignment requirement. */
export type AlignmentMode = 'relaxed' | 'strict';

/**
 * Hosting and publishing platforms where every account is its own subdomain.
 *
 * These are the suffixes where one customer must never be aligned with another.
 * Absent from this list the failure is conservative rather than dangerous, so it
 * is added when a real case is seen rather than speculatively.
 */
const MULTI_TENANT_SUFFIXES = [
  // Static hosting and publishing
  'github.io',
  'githubusercontent.com',
  'gitlab.io',
  'bitbucket.io',
  'pages.dev',
  'netlify.app',
  'vercel.app',
  'now.sh',
  'surge.sh',
  'glitch.me',
  'onrender.com',
  'fly.dev',
  'workers.dev',
  // Platform as a service
  'herokuapp.com',
  'azurewebsites.net',
  'appspot.com',
  'web.app',
  'firebaseapp.com',
  // CDN and object storage
  'cloudfront.net',
  'fastly.net',
  'edgekey.net',
  'akamaized.net',
  's3.amazonaws.com',
  // CMS and site builders
  'wordpress.com',
  'blogspot.com',
  'squarespace.com',
  'wixsite.com',
  'weebly.com',
  'webflow.io',
  'jimdo.com',
  'myshopify.com',
  // Collaboration and documentation
  'readthedocs.io',
  'atlassian.net',
  'zendesk.com',
];

/**
 * Public suffixes where the registrable domain is three labels.
 *
 * Without the full list, taking the last two labels of `acme.co.uk` gives
 * `co.uk`, which every `.co.uk` domain shares, and would make them all relaxed
 * aligned with each other. Same failure as the multi-tenant list, quieter.
 */
const SECOND_LEVEL_SUFFIXES = [
  'co.uk',
  'org.uk',
  'ac.uk',
  'gov.uk',
  'me.uk',
  'co.jp',
  'or.jp',
  'ne.jp',
  'com.au',
  'net.au',
  'org.au',
  'co.nz',
  'com.br',
  'com.mx',
  'com.ar',
  'co.in',
  'co.za',
  'com.sg',
  'com.hk',
  'com.tw',
  'co.kr',
  'com.tr',
  'com.eg',
  'com.sa',
  'com.pl',
  'com.ua',
  'co.il',
];

const SECOND_LEVEL = new Set(SECOND_LEVEL_SUFFIXES);

/**
 * Lowercases and strips a trailing dot, which DNS allows and comparison should not.
 *
 * Returns undefined rather than an empty string for nothing usable, because
 * callers chain these with `??`. An empty string is neither null nor undefined,
 * so `??` would stop on it and a later fallback in the chain would never run.
 */
export function normaliseForAlignment(domain: string | null | undefined): string | undefined {
  const clean = (domain ?? '').trim().toLowerCase().replace(/\.+$/, '');
  return clean === '' ? undefined : clean;
}

/**
 * The organisational domain: the public suffix plus one label.
 *
 * On a multi-tenant suffix the host already is that label, so it is returned
 * unchanged. That is the whole point of the multi-tenant list: `a.github.io` and
 * `b.github.io` resolve to different organisational domains and therefore do not
 * align, while `a.github.io` and `x.a.github.io` do, which is correct.
 */
export function organizationalDomain(host: string): string {
  const clean = normaliseForAlignment(host);
  if (!clean) {
    return '';
  }


  const labels = clean.split('.');

  // Longest suffix first, so a host matching two entries takes the more specific.
  for (const suffix of [...MULTI_TENANT_SUFFIXES].sort((a, b) => b.length - a.length)) {
    if (clean === suffix) {
      return clean;
    }

    if (clean.endsWith(`.${suffix}`)) {
      // The organisational domain is the public suffix plus exactly ONE label,
      // so a subdomain below a tenant still resolves to that tenant.
      //   victim.github.io       -> victim.github.io
      //   mail.victim.github.io  -> victim.github.io   (aligned, same tenant)
      //   attacker.github.io     -> attacker.github.io (not aligned, other tenant)
      const prefix = clean.slice(0, -(suffix.length + 1));
      const registrable = prefix.split('.').pop() ?? '';
      return `${registrable}.${suffix}`;
    }
  }

  if (labels.length > 2) {
    const tail = labels.slice(-2).join('.');
    if (SECOND_LEVEL.has(tail)) {
      return labels.slice(-3).join('.');
    }
  }

  return labels.slice(-2).join('.');
}

/** Reads a policy domain's own declaration of how it wants alignment judged. */
export function alignmentModeFromTag(tag: string | null | undefined): AlignmentMode {
  return tag?.trim().toLowerCase() === 's' ? 'strict' : 'relaxed';
}

/**
 * Whether an authenticating domain aligns with the policy domain.
 *
 * Exact match is aligned in both modes. Relaxed additionally accepts a shared
 * organisational domain, which is what makes signing on a subdomain work.
 */
export function isAligned(
  authDomain: string | null | undefined,
  policyDomain: string | null | undefined,
  mode: AlignmentMode = 'relaxed',
): boolean {
  const auth = normaliseForAlignment(authDomain);
  const policy = normaliseForAlignment(policyDomain);

  if (!auth || !policy) {
    return false;
  }

  if (auth === policy) {
    return true;
  }

  if (mode === 'strict') {
    return false;
  }

  return organizationalDomain(auth) === organizationalDomain(policy);
}

/**
 * The domain to attribute this record to, honouring declared alignment.
 *
 * Prefers an aligned result over merely present one, because attributing a
 * message to the domain that actually authenticated it is the entire point of
 * reading the auth results at all.
 */
export function resolveAlignedSender(input: {
  policyDomain: string;
  headerFrom?: string | null;
  envelopeFrom?: string | null;
  authResults: { type?: string; domain?: string | null; selector?: string; scope?: string; result?: string }[];
  adkim?: string | null;
  aspf?: string | null;
}): { senderDomain: string | undefined; matched: boolean; mode: AlignmentMode } {
  const { policyDomain, authResults } = input;

  let best: { domain: string; matched: boolean } | undefined;

  for (const result of authResults) {
    const domain = normaliseForAlignment(result?.domain);
    if (!domain) {
      continue;
    }

    // The tag applies to the protocol it belongs to, so a domain that asked for
    // strict SPF is not getting relaxed DKIM.
    const mode =
      result.type?.toUpperCase() === 'DKIM'
        ? alignmentModeFromTag(input.adkim)
        : alignmentModeFromTag(input.aspf);

    const matched = isAligned(domain, policyDomain, mode);

    if (matched) {
      return { senderDomain: domain, matched: true, mode };
    }

    best ??= { domain, matched: false };
  }

  if (best) {
    return { senderDomain: best.domain, matched: false, mode: 'relaxed' };
  }

  const fallback =
    normaliseForAlignment(
      authResults.find((r) => r?.type?.toUpperCase() === 'SPF')?.domain,
    ) ??
    normaliseForAlignment(
      authResults.find((r) => r?.type?.toUpperCase() === 'DKIM')?.domain,
    ) ??
    normaliseForAlignment(input.headerFrom) ??
    normaliseForAlignment(input.envelopeFrom);

  return { senderDomain: fallback || undefined, matched: false, mode: 'relaxed' };
}