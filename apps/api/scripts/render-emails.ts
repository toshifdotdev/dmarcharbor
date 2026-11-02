/**
 * render-emails.ts - every email the product sends, written out as HTML files to
 * open in a browser.
 *
 * Why this exists: the only other way to see an email is to make it happen. A
 * password reset needs an account, a lapsed domain registration needs a lapsed
 * domain, and an unacknowledged-alerts rollup needs alerts nobody acknowledged
 * for days. So a change to the layout used to be checked by reading markup.
 *
 * Every rendering here is built from plain sample values by the same functions
 * production calls: the templates in src/email/templates.ts, the alert wording
 * in src/services/alert-email.ts and the digest wording in
 * src/services/report-digest-text.ts. Nothing reads the database or the
 * network, and no sample has a logo, so opening the files fetches nothing.
 *
 * Client facing mail is rendered twice: in our brand, and in a sample agency's
 * white label (Wistholm IT, primary colour #0f766e, support address
 * help@wistholm.example). Staff mail is always ours, so it is rendered once.
 *
 *   npx tsx scripts/render-emails.ts [outDir]
 *
 * The folder defaults to "emails" in the system temp folder. Each message is
 * written to <outDir>/<name>.html, its text part to <outDir>/<name>.txt, and
 * <outDir>/index.html links them all.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  clientContact,
  contactSentence,
  dnsChangesEmail,
  domainExpiryEmail,
  domainVerificationNotice,
  emailVerificationEmail,
  erasureCompletedEmail,
  erasureScheduledEmail,
  escapeHtml,
  existingAccountSignUpEmail,
  exportReadyEmail,
  monthlyReportEmail,
  passwordResetEmail,
  paymentFailedEmail,
  planChangedEmail,
  planPausedFeaturesEmail,
  plainTextEmail,
  policyApprovalRequestedEmail,
  policyProposalDecidedEmail,
  portalAccessGranted,
  securityNoticeEmail,
  subscriptionCancelledEmail,
  workspaceInvitationEmail,
  type AuthEmailAgency,
  type BrandLook,
  type RenderedEmail,
} from '../src/email/templates.js';
import {
  alertEmail,
  alertEmailBody,
  escalationSubject,
  rollupEmailBody,
  rollupEmailSubject,
} from '../src/services/alert-email.js';
import type { DigestBranding } from '../src/services/report-digest-text.js';
import { readDmarcRecord } from '../src/scanner/dmarc-tags.js';

/*
 * The digest wording takes `oneLine` from email/sender.ts, which loads the
 * API's environment, and that fails closed to production when NODE_ENV is
 * unset; production then refuses the console email provider and stops the
 * run. A preview says what it is first. It is the only import that needs it,
 * so it is the only one loaded after this line.
 */
process.env.NODE_ENV ??= 'development';
const { digestEmail, digestEnvelope, digestLines } = await import('../src/services/report-digest-text.js');

const outDir = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'emails'));

/* ------------------------------------------------------------ sample data */

const appUrl = 'https://app.dmarcharbor.example';
const agencyOrigin = 'https://reports.wistholm.example';
const when = '2026-12-14T09:30:00.000Z';

const agencyName = 'Wistholm IT';
const supportEmail = 'help@wistholm.example';
const agencyBrand: BrandLook = { workspaceName: agencyName, logoUrl: null, primaryColor: '#0f766e', accentColor: null };
const agencyBranding: DigestBranding = {
  branded: true,
  workspaceName: agencyName,
  logoUrl: null,
  primaryColor: '#0f766e',
  accentColor: null,
  supportEmail,
  supportUrl: null,
};
const agencyContact = clientContact(agencyBranding);
/** The same agency below white label: its name, none of its look, no contact line. */
const plainAgency: BrandLook = { workspaceName: agencyName };
const authAgency: AuthEmailAgency = { name: agencyName, brand: agencyBrand, supportEmail };

const client = 'Pellowyn Dental';
const domain = 'pellowyn-dental.example';

/* ------------------------------------------------------------- renderings */

interface Rendering {
  name: string;
  /** Who reads it, and in whose brand. */
  note: string;
  email: RenderedEmail;
}

const renderings: Rendering[] = [];
const add = (name: string, note: string, email: RenderedEmail) => renderings.push({ name, note, email });

// Account mail.
add('password-reset', 'Account, our brand', passwordResetEmail({ url: `${appUrl}/api/auth/reset-password/tok_sample?callbackURL=%2Fsign-in` }));
add(
  'password-reset-agency',
  'Account, Wistholm IT white label',
  passwordResetEmail({ url: `${agencyOrigin}/api/auth/reset-password/tok_sample?callbackURL=%2Fsign-in`, agency: authAgency }),
);
add('email-verification', 'Account, our brand', emailVerificationEmail({ url: `${appUrl}/api/auth/verify-email?token=tok_sample` }));
add(
  'email-verification-agency',
  'Account, Wistholm IT white label',
  emailVerificationEmail({ url: `${agencyOrigin}/api/auth/verify-email?token=tok_sample`, agency: authAgency }),
);
add('existing-account-sign-up', 'Account, names no product', existingAccountSignUpEmail());
const securityNotices: Array<[string, string, string]> = [
  ['security-two-step-on', 'Two-step verification was turned on', 'Two-step verification was turned on for your DMARC Harbor account.'],
  ['security-two-step-off', 'Two-step verification was turned off', 'Two-step verification was turned off for your DMARC Harbor account.'],
  ['security-backup-code-used', 'A backup code was used to sign in', 'A backup code was used to sign in. 2 left. Generate new ones in Account security.'],
  ['security-backup-codes-new', 'New backup codes were generated', 'New backup codes were generated; the old ones no longer work.'],
  [
    'security-reset-by-owner',
    'Your two-step verification was reset',
    `Your two-step verification was reset by an owner of ${agencyName}. Sign in with your password and set it up again.`,
  ],
  [
    'security-reset-by-support',
    'Your two-step verification was reset',
    'Your two-step verification was reset by DMARC Harbor support. Sign in with your password and set it up again.',
  ],
];
for (const [name, subject, notice] of securityNotices) {
  add(name, 'Account, our brand', securityNoticeEmail({ subject, notice, appUrl }));
}

// Staff mail, always ours.
add(
  'workspace-invitation',
  'Staff, our brand',
  workspaceInvitationEmail({ workspaceName: agencyName, inviterName: 'Ffion Rees', role: 'admin', signInUrl: `${appUrl}/welcome`, expiresAt: when }),
);
add(
  'policy-decided-approved',
  'Staff, our brand',
  policyProposalDecidedEmail({
    workspaceName: agencyName,
    title: `${client} approved p=reject for ${domain}`,
    body: `${client} approved moving ${domain} to p=reject. Publish the record when you are ready; the request is closed.`,
    url: `${appUrl}/domains/pellowyn-dental-example`,
    decision: 'approved',
  }),
);
add(
  'policy-decided-declined',
  'Staff, our brand',
  policyProposalDecidedEmail({
    workspaceName: agencyName,
    title: `${client} declined p=reject for ${domain}`,
    body: `${client} declined moving ${domain} to p=reject. Their reason: "Wait until the new booking system is live."`,
    url: `${appUrl}/domains/pellowyn-dental-example`,
    decision: 'declined',
  }),
);
add(
  'dns-changes',
  'Staff, our brand',
  dnsChangesEmail({
    workspaceName: agencyName,
    appUrl,
    changes: [
      { domainName: domain, domainSlug: 'pellowyn-dental-example', summary: 'The DMARC policy changed from p=reject to p=none.' },
      { domainName: 'corriwick-cafe.example', domainSlug: 'corriwick-cafe-example', summary: 'An SPF include was added: include:_spf.hubspot.example.' },
    ],
  }),
);
add(
  'domain-expiry',
  'Staff, our brand',
  domainExpiryEmail({
    workspaceName: agencyName,
    appUrl,
    domains: [
      { domainSlug: 'pellowyn-dental-example', sentence: `${domain}: The registration expires in 14 days, on 28 December 2026.`, registrar: 'Sample Registrar' },
      { domainSlug: 'haskerley-law-example', sentence: 'haskerley-law.example: The registration expires in 30 days, on 13 January 2027.', registrar: null },
    ],
  }),
);
add(
  'domain-expiry-expired',
  'Staff, our brand',
  domainExpiryEmail({
    workspaceName: agencyName,
    appUrl,
    domains: [
      {
        domainSlug: 'ollerbeck-vets-example',
        sentence: 'ollerbeck-vets.example: The registration expired on 12 December 2026, 2 days ago.',
        registrar: 'Sample Registrar',
        expired: true,
      },
    ],
  }),
);
add(
  'domain-verified',
  'Staff, our brand',
  domainVerificationNotice({ workspaceName: agencyName, domainName: domain, verified: true, appUrl: `${appUrl}/domains/pellowyn-dental-example` }),
);
add(
  'domain-lost-verification',
  'Staff, our brand',
  domainVerificationNotice({ workspaceName: agencyName, domainName: domain, verified: false, appUrl: `${appUrl}/domains/pellowyn-dental-example` }),
);
add('payment-failed', 'Staff, our brand', paymentFailedEmail({ workspaceName: agencyName, planLabel: 'Harbor', graceEndsAt: when, billingUrl: `${appUrl}/settings/billing` }));
add(
  'subscription-cancelled',
  'Staff, our brand',
  subscriptionCancelledEmail({ workspaceName: agencyName, planLabel: 'Harbor', accessUntil: when, billingUrl: `${appUrl}/settings/billing` }),
);
add(
  'plan-changed-immediate',
  'Staff, our brand',
  planChangedEmail({ workspaceName: agencyName, fromLabel: 'Fairway', toLabel: 'Harbor', effectiveAt: when, timing: 'immediate', billingUrl: `${appUrl}/settings/billing` }),
);
add(
  'plan-changed-cycle-end',
  'Staff, our brand',
  planChangedEmail({ workspaceName: agencyName, fromLabel: 'Harbor', toLabel: 'Fairway', effectiveAt: when, timing: 'cycle_end', billingUrl: `${appUrl}/settings/billing` }),
);
add(
  'plan-paused-features',
  'Staff, our brand',
  planPausedFeaturesEmail({
    workspaceName: agencyName,
    planLabel: 'Fairway',
    hostedRecords: ['3 hosted DMARC records', '1 hosted SPF record'],
    sso: { connections: 1, signInUntil: when },
    customDomain: 'reports.wistholm.example',
    appUrl,
    billingUrl: `${appUrl}/settings/billing`,
  }),
);
add('export-ready', 'Staff, our brand', exportReadyEmail({ workspaceName: agencyName, scopeLabel: 'workspace', downloadUrl: `${appUrl}/exports/exp_sample`, expiresAt: when }));
add(
  'erasure-scheduled',
  'Staff, our brand',
  erasureScheduledEmail({ workspaceName: agencyName, scopeLabel: 'client', executesAt: when, cancelUrl: `${appUrl}/settings/erasure` }),
);
add('erasure-completed', 'Staff, our brand', erasureCompletedEmail({ workspaceName: agencyName, scopeLabel: 'client', completedAt: when }));

// Client mail, in both brands.
for (const [suffix, brand, branded, note] of [
  ['', plainAgency, false, 'Client, our look (white label off)'],
  ['-agency', agencyBrand, true, 'Client, Wistholm IT white label'],
] as const) {
  const contact = branded ? agencyContact : null;
  const origin = branded ? agencyOrigin : appUrl;
  add(
    `portal-access${suffix}`,
    note,
    portalAccessGranted({ brand, clientName: client, signInUrl: `${origin}/portal`, agencyName, contact }),
  );
  add(
    `policy-approval-request${suffix}`,
    note,
    policyApprovalRequestedEmail({
      brand,
      agencyName,
      clientName: client,
      domainName: domain,
      headline: `Move ${domain} to p=reject`,
      effect: 'Mail that fails DMARC is refused instead of delivered, so nobody can send as this domain.',
      trial: null,
      risk: 'A service that sends as the domain and is not set up correctly would have its mail refused.',
      evidence: 'Every service that sends as the domain has passed DMARC for 30 days.',
      note: 'This is the last step we discussed in October.',
      openPoints: ['The booking reminders from the new system have not been seen yet.'],
      expiresAt: when,
      url: `${origin}/portal/domain/dom_sample`,
      contact,
    }),
  );
  add(
    `monthly-report${suffix}`,
    note,
    monthlyReportEmail({
      brand,
      branded,
      agencyName,
      clientName: client,
      periodLabel: 'November 2026',
      messages: 48210,
      passRate: '99.2%',
      domainsAtReject: 2,
      downloadUrl: `${origin}/reports/download?token=tok_sample`,
      reference: 'MR-2026-11-7Q4K',
      verifyUrl: `${origin}/verify?reference=MR-2026-11-7Q4K`,
      contact,
    }),
  );
}
add(
  'monthly-report-no-reports',
  'Client, our look (white label off)',
  monthlyReportEmail({
    brand: plainAgency,
    branded: false,
    agencyName,
    clientName: 'Thrandle Build',
    periodLabel: 'November 2026',
    messages: 0,
    passRate: '0%',
    domainsAtReject: 0,
    downloadUrl: `${appUrl}/reports/download?token=tok_sample`,
    reference: 'MR-2026-11-2B8D',
    verifyUrl: `${appUrl}/verify?reference=MR-2026-11-2B8D`,
  }),
);

// Alerts, staff mail through the same wording alert.service.ts sends.
const rule = {
  organizationName: agencyName,
  domainName: domain,
  ruleName: 'Failure rate',
  metric: 'FAILURE_RATE',
  summary: '12.4% of 4,210 messages failed DMARC in the last 60 minutes (threshold 5%).',
  operator: 'GT',
  threshold: 5,
  windowMinutes: 60,
  maxReminderLevel: 3,
  spoofingSources: null,
};
for (const level of [1, 2, 3]) {
  const subject = escalationSubject({ domain: { name: domain }, name: rule.ruleName }, level);
  add(`alert-level-${level}`, 'Staff, our brand', alertEmail({ subject, body: alertEmailBody({ ...rule, reminderLevel: level }), kind: 'ALERT', appUrl }));
}
add(
  'alert-spoofing',
  'Staff, our brand',
  alertEmail({
    subject: escalationSubject({ domain: { name: domain }, name: 'New unauthenticated sender' }, 1),
    body: alertEmailBody({
      ...rule,
      ruleName: 'New unauthenticated sender',
      metric: 'NEW_UNAUTHENTICATED_SOURCE',
      summary: '1 new source sent as the domain and failed both SPF and DKIM.',
      operator: 'GTE',
      threshold: 1,
      windowMinutes: 1440,
      reminderLevel: 1,
      spoofingSources: [
        {
          senderKey: 'lookalike',
          senderDomain: 'mail.pellowyn-dentel.example',
          serviceName: null,
          totalMessages: 64,
          failedMessages: 64,
          sourceIps: ['203.0.113.24', '203.0.113.25'],
          firstSeenAt: '2026-12-13T22:10:00.000Z',
        },
      ],
    }),
    kind: 'ALERT',
    appUrl,
  }),
);
const outstanding = [
  { domainName: domain, ruleName: 'Failure rate', summary: '12.4% failed DMARC' },
  { domainName: 'corriwick-cafe.example', ruleName: 'Report silence', summary: 'No reports for 52 hours' },
  { domainName: 'haskerley-law.example', ruleName: 'New unauthenticated sender', summary: '1 new failing source' },
];
add(
  'alert-rollup',
  'Staff, our brand',
  alertEmail({
    subject: rollupEmailSubject(outstanding.length),
    body: rollupEmailBody({ organizationName: agencyName, outstanding }),
    kind: 'ROLLUP',
    appUrl,
  }),
);

// Domain summary digests, client mail, through the wording report-digest.service.ts sends.
const digestFigures = {
  domain: { name: domain, score: 86, dmarcPolicy: 'quarantine', client: { name: client } },
  insights: {
    aggregate: {
      reportCount: 41,
      messageCount: 11840,
      failedMessages: 96,
      dmarcPassRate: 99.2,
      spfPassRate: 97.4,
      dkimPassRate: 98.9,
      lastReportAt: '2026-12-14T06:02:11.000Z',
    },
    forensic: { count: 3, rejectedMessages: 3, affectedRecipients: 2, lastReportAt: null },
    sources: [
      { sourceIp: '40.107.22.53', failedMessages: 0, totalMessages: 8210, risk: 'low' as const },
      { sourceIp: '198.51.100.14', failedMessages: 2, totalMessages: 2930, risk: 'low' as const },
      { sourceIp: '203.0.113.24', failedMessages: 64, totalMessages: 64, risk: 'high' as const },
    ],
  },
  readiness: { ready: false, level: 'reject' as const, blockers: ['One sender still fails DKIM alignment.'] },
  tags: readDmarcRecord('v=DMARC1; p=quarantine; rua=mailto:dmarc@reports.dmarcharbor.example'),
  includeForensics: true,
};
for (const [suffix, branding, note] of [
  ['', null, 'Client, our brand (white label off)'],
  ['-agency', agencyBranding, 'Client, Wistholm IT white label'],
] as const) {
  const branded = Boolean(branding?.branded);
  const envelope = digestEnvelope({
    domainName: domain,
    organizationName: agencyName,
    branded,
    lines: digestLines({ ...digestFigures, branded }),
  });
  // As sendDigest does: the contact line is appended to the text under white label.
  const contactLine = contactSentence(clientContact(branding));
  const text = contactLine ? `${envelope.text}\n\n${contactLine}` : envelope.text;
  add(`digest${suffix}`, note, digestEmail({ subject: envelope.subject, text, branding }));
}

// The transport's fallback for a caller that sends text with no HTML of its own.
add(
  'plain-text-fallback',
  'Fallback, our brand',
  plainTextEmail({
    subject: 'A message written as plain text',
    text: 'This is what any text-only caller gets.\n\nA second paragraph, with a link: https://app.dmarcharbor.example/alerts.',
    kind: null,
  }),
);

/* ------------------------------------------------------------------ write */

function indexHtml(): string {
  const items = renderings
    .map(
      (entry) =>
        `<tr><td style="padding:10px 16px 10px 0;border-top:1px solid #e7e9ed;"><a href="${escapeHtml(entry.name)}.html" style="color:#15171b;font-weight:700;">${escapeHtml(entry.name)}</a> <a href="${escapeHtml(entry.name)}.txt" style="color:#6c717a;">text</a></td><td style="padding:10px 16px 10px 0;border-top:1px solid #e7e9ed;color:#41454d;">${escapeHtml(entry.email.subject)}</td><td style="padding:10px 0;border-top:1px solid #e7e9ed;color:#6c717a;">${escapeHtml(entry.note)}</td></tr>`,
    )
    .join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Email previews</title></head>
<body style="margin:0;padding:48px 24px;background:#ffffff;color:#15171b;font-family:'Albert Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;">
<h1 style="margin:0 0 8px;font-size:30px;letter-spacing:-0.02em;">Email previews</h1>
<p style="margin:0 0 24px;color:#41454d;">${renderings.length} renderings from sample data, written ${escapeHtml(new Date().toISOString())}. Sample agency: Wistholm IT.</p>
<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;max-width:1100px;">
<tr><th align="left" style="padding:0 16px 8px 0;color:#5f646c;font-size:13px;">File</th><th align="left" style="padding:0 16px 8px 0;color:#5f646c;font-size:13px;">Subject</th><th align="left" style="padding:0 0 8px;color:#5f646c;font-size:13px;">Reader and brand</th></tr>
${items}
</table>
</body></html>`;
}

async function main(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  for (const entry of renderings) {
    await writeFile(path.join(outDir, `${entry.name}.html`), entry.email.html, 'utf8');
    await writeFile(path.join(outDir, `${entry.name}.txt`), `Subject: ${entry.email.subject}\n\n${entry.email.text}\n`, 'utf8');
  }
  await writeFile(path.join(outDir, 'index.html'), indexHtml(), 'utf8');
  console.log(`[emails] wrote ${renderings.length} renderings and index.html to ${outDir}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
