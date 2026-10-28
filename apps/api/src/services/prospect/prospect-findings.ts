import type { ScanResult } from '../../models/scan.model.js';

/**
 * What a scan means to someone who has never heard of DMARC.
 *
 * A prospect reads this, not a technician. Every finding answers three
 * questions in plain words: what is true today, why it matters to the
 * business, and what fixing it involves. Nothing is claimed that the scan did
 * not observe; where public DNS cannot prove something (DKIM keys can live
 * under any name), the sentence says what was checked rather than declaring
 * an absence.
 */

export type FindingStatus = 'risk' | 'warn' | 'unknown' | 'info' | 'good';
export type RiskLevel = 'high' | 'medium' | 'low';

export interface ProspectFinding {
  key: string;
  area: string;
  status: FindingStatus;
  headline: string;
  detail: string;
  fix: string | null;
}

export interface ProspectAssessment {
  level: RiskLevel;
  headline: string;
  summary: string;
  findings: ProspectFinding[];
}

const statusOrder: Record<FindingStatus, number> = { risk: 0, warn: 1, unknown: 2, info: 3, good: 4 };

function spoofing(scan: ScanResult, domain: string): ProspectFinding {
  const area = 'Protection against forged email (DMARC)';
  const dmarc = scan.dmarc;
  if (dmarc.status === 'error') {
    return {
      key: 'spoofing',
      area,
      status: 'unknown',
      headline: `The DMARC record for ${domain} could not be read when we checked.`,
      detail: 'The DNS lookup failed, so this report makes no claim either way about forged email.',
      fix: null,
    };
  }
  if (dmarc.status === 'missing') {
    return {
      key: 'spoofing',
      area,
      status: 'risk',
      headline: `Anyone can send email that claims to be from ${domain}.`,
      detail: `There is no DMARC record, so receiving mail servers have no instruction from ${domain} about forged mail. A criminal can send an invoice, a payment change or a password reset "from" accounts@${domain}, and it arrives looking genuine to your customers and suppliers.`,
      fix: 'Publish a DMARC record that collects reports, find every service that legitimately sends your mail, then move the policy to reject so forgeries are refused.',
    };
  }
  const policy = dmarc.effectivePolicy ?? dmarc.policy;
  const testing = dmarc.testing ? ' The record is also in testing mode (t=y), which softens the policy by one step.' : '';
  if (policy === 'reject') {
    return {
      key: 'spoofing',
      area,
      status: 'good',
      headline: `Forged email claiming to be from ${domain} is refused.`,
      detail: `DMARC is published at p=reject, so receivers that check DMARC (Gmail, Microsoft, Yahoo and most others) refuse mail that fails it.${testing}`,
      fix: null,
    };
  }
  if (policy === 'quarantine') {
    return {
      key: 'spoofing',
      area,
      status: 'warn',
      headline: `Forged email claiming to be from ${domain} is sent to spam, not refused.`,
      detail: `DMARC is at p=quarantine. That stops most forgeries reaching the inbox, but they still arrive in junk folders, where people do open them.${testing}`,
      fix: 'Once reports show every real sender passing, move the policy to p=reject.',
    };
  }
  return {
    key: 'spoofing',
    area,
    status: 'risk',
    headline: `Forged email claiming to be from ${domain} is not blocked.`,
    detail: `DMARC is published at p=none, which only asks receivers for reports. They still deliver mail that fails the check, so a forgery reaches the inbox exactly as it would with no record at all.${testing}`,
    fix: 'Use the reports to confirm every real sender, then move the policy to quarantine and then reject.',
  };
}

function reporting(scan: ScanResult, domain: string): ProspectFinding | null {
  if (scan.dmarc.status !== 'found') return null;
  const area = 'Visibility of who sends as you (DMARC reports)';
  if (scan.dmarc.hasAggregateReports) {
    return {
      key: 'reporting',
      area,
      status: 'good',
      headline: 'Receivers are asked to send daily reports about mail using the domain.',
      detail: 'The record has a reporting address (rua=). Those reports show every server that sent mail as the domain, including forgeries, which is how a policy can be tightened safely.',
      fix: null,
    };
  }
  return {
    key: 'reporting',
    area,
    status: 'warn',
    headline: `Nobody receives the reports that show who sends email as ${domain}.`,
    detail: 'The DMARC record has no reporting address (rua=), so forgeries and misconfigured senders go unseen, and there is no evidence to tighten the policy with.',
    fix: 'Add a reporting address to the DMARC record so the daily reports are collected and read.',
  };
}

function senders(scan: ScanResult, domain: string): ProspectFinding {
  const area = 'List of servers allowed to send (SPF)';
  const spf = scan.spf;
  if (spf.status === 'error') {
    return {
      key: 'senders',
      area,
      status: 'unknown',
      headline: 'The SPF record could not be read when we checked.',
      detail: 'The DNS lookup failed, so this report makes no claim about it.',
      fix: null,
    };
  }
  if (spf.status === 'missing') {
    return {
      key: 'senders',
      area,
      status: 'risk',
      headline: `${domain} does not say which servers may send its email.`,
      detail: 'There is no SPF record. Receivers cannot tell your own mail servers from anyone else, and many treat mail without SPF as suspicious.',
      fix: 'Publish an SPF record listing the services that send your mail (your email provider, your CRM, your invoicing tool).',
    };
  }
  if (spf.lookupLimitExceeded) {
    return {
      key: 'senders',
      area,
      status: 'risk',
      headline: 'The SPF record is too long for receivers to evaluate.',
      detail: `It needs ${spf.lookupCount} DNS lookups and the standard allows 10. Past that, receivers treat SPF as broken, so even genuine mail can fail.`,
      fix: 'Consolidate the record (remove unused services, or flatten it) so it stays within 10 lookups.',
    };
  }
  if (!spf.valid || (spf.problems?.length ?? 0) > 0) {
    return {
      key: 'senders',
      area,
      status: 'warn',
      headline: 'The SPF record has problems.',
      detail: spf.problems?.[0] ?? 'The record does not parse cleanly, so receivers may ignore part or all of it.',
      fix: 'Correct the SPF record so every receiver reads it the same way.',
    };
  }
  return {
    key: 'senders',
    area,
    status: 'good',
    headline: 'An SPF record lists the servers allowed to send.',
    detail: `It needs ${spf.lookupCount} of the 10 DNS lookups the standard allows.`,
    fix: null,
  };
}

function signing(scan: ScanResult): ProspectFinding {
  const area = 'Tamper-proof signatures on outgoing mail (DKIM)';
  const dkim = scan.dkim;
  if (dkim.status === 'error') {
    return {
      key: 'signing',
      area,
      status: 'unknown',
      headline: 'DKIM keys could not be checked when we looked.',
      detail: 'The DNS lookups failed, so this report makes no claim about signing.',
      fix: null,
    };
  }
  if (dkim.selectors.length > 0) {
    return {
      key: 'signing',
      area,
      status: 'good',
      headline: 'Outgoing mail is signed (DKIM keys were found).',
      detail: `Keys were published under: ${dkim.selectors.slice(0, 5).join(', ')}. A signature proves a message was not altered and really came from an authorised sender.`,
      fix: null,
    };
  }
  return {
    key: 'signing',
    area,
    status: 'warn',
    headline: 'No DKIM signing keys were found under the common names.',
    detail: `We checked ${dkim.checkedSelectors.length} common selector names and found no key. Keys can live under any name, so this is not proof there are none, but if there are none, mail cannot be signed and DMARC has only SPF to rely on.`,
    fix: 'Turn on DKIM signing in each service that sends your mail and publish the keys it gives you.',
  };
}

function inboxRules(scan: ScanResult, domain: string): ProspectFinding {
  const area = 'Gmail, Yahoo and Microsoft sender requirements';
  const hasDmarc = scan.dmarc.status === 'found';
  const hasSpf = scan.spf.status === 'found' && scan.spf.valid && !scan.spf.lookupLimitExceeded;
  const hasDkim = scan.dkim.selectors.length > 0;
  if (hasDmarc && hasSpf && hasDkim) {
    return {
      key: 'inbox-rules',
      area,
      status: 'good',
      headline: 'The records the big mailbox providers require are in place.',
      detail: 'Gmail, Yahoo and Microsoft require SPF, DKIM and DMARC from senders of bulk mail. All three were found.',
      fix: null,
    };
  }
  const missing = [!hasSpf ? 'SPF' : null, !hasDkim ? 'DKIM' : null, !hasDmarc ? 'DMARC' : null].filter(Boolean);
  return {
    key: 'inbox-rules',
    area,
    status: hasDmarc ? 'warn' : 'risk',
    headline: `Mail from ${domain} may be sent to spam or rejected by Gmail, Yahoo and Outlook.`,
    detail: `Since 2024 these providers require SPF, DKIM and DMARC from anyone sending in bulk, and they have been rejecting non-compliant mail. Not found or not working: ${missing.join(', ')}.`,
    fix: `Put ${missing.join(' and ')} in place for every service that sends your mail.`,
  };
}

function encryption(scan: ScanResult, domain: string): ProspectFinding | null {
  if (scan.mx.status !== 'found' || !scan.mtaSts) return null;
  const area = 'Encrypted delivery of mail to you (MTA-STS)';
  const mode = scan.mtaSts.policy?.mode;
  if (scan.mtaSts.status === 'found' && mode === 'enforce') {
    return {
      key: 'encryption',
      area,
      status: 'good',
      headline: `Senders must use encryption when delivering mail to ${domain}.`,
      detail: 'An MTA-STS policy is enforced, so mail cannot be downgraded to an unencrypted connection on its way in.',
      fix: null,
    };
  }
  return {
    key: 'encryption',
    area,
    status: 'info',
    headline: `Mail delivered to ${domain} can be downgraded to an unencrypted connection.`,
    detail:
      scan.mtaSts.status === 'found'
        ? 'An MTA-STS policy is published but not enforced, so senders report problems without refusing an insecure connection.'
        : 'There is no MTA-STS policy, so someone positioned on the network path can force incoming mail to travel unencrypted.',
    fix: 'Publish an MTA-STS policy, run it in testing mode with TLS reporting, then enforce it.',
  };
}

function receiving(scan: ScanResult, domain: string): ProspectFinding | null {
  if (scan.mx.status !== 'missing') return null;
  return {
    key: 'receiving',
    area: 'Mail servers (MX)',
    status: 'info',
    headline: `${domain} publishes no mail servers, so it does not receive email.`,
    detail: 'A domain that sends no mail should still publish a reject policy and an empty SPF record, so nobody can use it to send forgeries.',
    fix: 'If the domain sends no mail, publish v=spf1 -all and a DMARC record at p=reject.',
  };
}

function brandLogo(scan: ScanResult): ProspectFinding | null {
  if (!scan.bimi) return null;
  if (scan.bimi.status === 'found' && !scan.bimi.declined) {
    return {
      key: 'brand',
      area: 'Logo in the inbox (BIMI)',
      status: 'good',
      headline: 'A brand logo is published for inboxes that show one.',
      detail: 'BIMI is set up, so supporting mailboxes can show the logo beside authenticated mail.',
      fix: null,
    };
  }
  return null;
}

/** The whole assessment, worst first. */
export function assessProspect(scan: ScanResult): ProspectAssessment {
  const domain = scan.domain;
  const findings = [
    spoofing(scan, domain),
    reporting(scan, domain),
    senders(scan, domain),
    signing(scan),
    inboxRules(scan, domain),
    encryption(scan, domain),
    receiving(scan, domain),
    brandLogo(scan),
  ].filter((finding): finding is ProspectFinding => finding !== null);

  findings.sort((a, b) => statusOrder[a.status] - statusOrder[b.status]);

  const spoof = findings.find((finding) => finding.key === 'spoofing')!;
  const anyRisk = findings.some((finding) => finding.status === 'risk');
  const anyWarn = findings.some((finding) => finding.status === 'warn');

  const level: RiskLevel = spoof.status === 'risk' ? 'high' : anyRisk || anyWarn || spoof.status !== 'good' ? 'medium' : 'low';
  const counted = findings.filter((finding) => finding.status === 'risk' || finding.status === 'warn').length;

  const headline =
    level === 'high'
      ? `${domain} can be impersonated by email today.`
      : level === 'medium'
        ? `${domain} is partly protected against email impersonation.`
        : `${domain} is well protected against email impersonation.`;
  const summary =
    level === 'low'
      ? 'The checks below found the records that stop forged email in place. Monitoring keeps them that way as services are added.'
      : `We found ${counted} thing${counted === 1 ? '' : 's'} to fix. Each is explained below in plain words, with what fixing it involves.`;

  return { level, headline, summary, findings };
}
