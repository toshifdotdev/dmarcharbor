/**
 * Email templates.
 *
 * Every template produces both HTML and a plain text alternative. That is not
 * belt and braces for its own sake: a text part is what keeps a message out of
 * the spam folder, and a message with no text part is routinely filtered. A
 * single-part HTML email also renders as raw markup in some clients, which for
 * a security notification is worse than useless.
 *
 * Client facing templates accept branding, so an agency's logo and colours
 * appear on the mail a customer contact receives. Agency facing templates
 * deliberately keep DMARC Harbor branding, because support stays unambiguous.
 *
 * Everything is built by string interpolation with a strict `escapeHtml`, since
 * these values include client names and domains chosen by the user.
 */

export interface BrandLook {
  workspaceName: string;
  logoUrl?: string | null;
  primaryColor?: string | null;
  accentColor?: string | null;
}

const fallbackPrimary = '#0f172a';
const fallbackAccent = '#0ea5e9';

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * A stored instant as a person reads it in an email: "30 October 2026, 14:37 UTC".
 * Every date reached these emails as a raw ISO string. Anything that is not a
 * date is passed through unchanged rather than printed as "Invalid Date".
 */
export function readableDate(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return `${parsed.toLocaleString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  })} UTC`;
}

/** A colour is only ever emitted as a CSS value, so the shape is constrained. */
function safeColour(value: string | null | undefined, fallback: string): string {
  if (!value) {
    return fallback;
  }
  return /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

interface LayoutInput {
  title: string;
  preheader: string;
  heading: string;
  paragraphs: string[];
  action?: { label: string; url: string } | null;
  /** Rendered after the action, for example a code or a warning. */
  aside?: { heading: string; body: string } | null;
  footer: string;
  brand?: BrandLook | null;
  /** Client facing mail uses the agency's brand; agency mail does not. */
  whiteLabel?: boolean;
}

function layout(input: LayoutInput): RenderedEmail {
  const useBrand = Boolean(input.whiteLabel && input.brand);
  const productName = useBrand ? input.brand!.workspaceName : 'DMARC Harbor';
  const primary = safeColour(useBrand ? input.brand!.primaryColor : null, fallbackPrimary);
  const accent = safeColour(useBrand ? input.brand!.accentColor : null, fallbackAccent);
  const logo = useBrand ? input.brand!.logoUrl : null;

  const heading = input.heading.replace(productName, productName);

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(input.title)}</title>
</head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0f172a;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(input.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:24px 12px;">
<tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0;">
  <tr><td style="background:${primary};padding:20px 28px;">
    ${
      logo
        ? `<img src="${escapeHtml(logo)}" alt="${escapeHtml(productName)}" height="36" style="height:36px;max-height:36px;display:block;border:0;">`
        : `<span style="color:#ffffff;font-size:18px;font-weight:700;letter-spacing:-0.01em;">${escapeHtml(productName)}</span>`
    }
  </td></tr>
  <tr><td style="padding:28px;">
    <h1 style="margin:0 0 16px;font-size:20px;line-height:1.3;">${escapeHtml(heading)}</h1>
    ${input.paragraphs
      .map(
        (paragraph) =>
          `<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#334155;">${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`,
      )
      .join('\n    ')}
    ${
      input.action
        ? `<p style="margin:24px 0;"><a href="${escapeHtml(input.action.url)}" style="display:inline-block;background:${accent};color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600;font-size:15px;">${escapeHtml(input.action.label)}</a></p>
    <p style="margin:0;font-size:13px;color:#64748b;">If the button does not work, copy this link into your browser:<br><span style="word-break:break-all;">${escapeHtml(input.action.url)}</span></p>`
        : ''
    }
    ${
      input.aside
        ? `<table role="presentation" width="100%" style="margin:24px 0 0;background:#f8fafc;border-left:3px solid ${accent};border-radius:6px;"><tr><td style="padding:14px 16px;">
    <p style="margin:0 0 4px;font-size:13px;font-weight:700;color:#0f172a;">${escapeHtml(input.aside.heading)}</p>
    <p style="margin:0;font-size:13px;line-height:1.6;color:#475569;">${escapeHtml(input.aside.body).replace(/\n/g, '<br>')}</p>
  </td></tr></table>`
        : ''
    }
  </td></tr>
  <tr><td style="padding:18px 28px;background:#f8fafc;border-top:1px solid #e2e8f0;">
    <p style="margin:0;font-size:12px;line-height:1.6;color:#64748b;">${escapeHtml(input.footer)}</p>
  </td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

  const text = [
    heading,
    '',
    ...input.paragraphs.flatMap((paragraph) => [paragraph, '']),
    input.action ? `${input.action.label}: ${input.action.url}` : '',
    input.aside ? `${input.aside.heading}\n${input.aside.body}` : '',
    '',
    input.footer,
  ]
    .filter((line) => line !== '')
    .join('\n');

  return { subject: input.title, html, text };
}

/* ----------------------------------------------------------------- templates */

/**
 * An invitation to join a workspace as a team member. Agency facing, so it is
 * DMARC Harbor's message, not the agency's brand.
 */
export function workspaceInvitationEmail(input: {
  workspaceName: string;
  inviterName: string;
  role: string;
  signInUrl: string;
  expiresAt: string | null;
}): RenderedEmail {
  const article = /^[aeiou]/i.test(input.role) ? 'an' : 'a';
  return layout({
    title: `${input.inviterName} invited you to ${input.workspaceName}`,
    preheader: `Join ${input.workspaceName} on DMARC Harbor as ${article} ${input.role}.`,
    heading: `Join ${input.workspaceName} on DMARC Harbor`,
    paragraphs: [
      `${input.inviterName} has invited you to work in ${input.workspaceName} as ${article} ${input.role}.`,
      'Sign in, or create an account, with this email address. The invitation is waiting on the first screen.',
      input.expiresAt ? `The invitation lapses on ${readableDate(input.expiresAt)}.` : '',
      'If you were not expecting this, you can ignore it. Nothing happens unless you accept.',
    ].filter(Boolean),
    action: { label: 'Open the invitation', url: input.signInUrl },
    footer: 'You are receiving this because someone invited this address to a DMARC Harbor workspace.',
  });
}

export function portalAccessGranted(input: {
  brand: BrandLook;
  clientName: string;
  signInUrl: string;
  agencyName: string;
}): RenderedEmail {
  return layout({
    title: `You can now see DMARC reports for ${input.clientName}`,
    preheader: `${input.agencyName} has given you access to their DMARC reporting.`,
    heading: `You can now see DMARC reports for ${input.clientName}`,
    paragraphs: [
      `${input.agencyName} has given you access to the DMARC reporting for ${input.clientName}. You can see report volume, senders, and any spoofing warnings.`,
      'Sign in with this email address to view it. There is no separate account to create and no password to remember.',
      'This access is managed by your IT provider. If you did not expect it, you can ignore this message.',
    ],
    action: { label: 'View reports', url: input.signInUrl },
    footer: 'This message was sent because an IT provider added this address to a DMARC reporting account.',
    brand: input.brand,
    whiteLabel: true,
  });
}

/**
 * Asks a client contact to approve a stricter DMARC policy. Client facing, so
 * it carries the agency's brand, and it says what changes in sentences: the
 * reader is the person who carries the risk, not an email engineer.
 */
export function policyApprovalRequestedEmail(input: {
  brand: BrandLook;
  agencyName: string;
  clientName: string;
  domainName: string;
  headline: string;
  effect: string;
  trial: string | null;
  risk: string;
  evidence: string | null;
  note: string | null;
  openPoints: string[];
  expiresAt: string;
  url: string;
}): RenderedEmail {
  return layout({
    title: `${input.agencyName} asks your approval: ${input.headline}`,
    preheader: `A change to how ${input.domainName} is protected, waiting for your decision.`,
    heading: input.headline,
    paragraphs: [
      `${input.agencyName} looks after email security for ${input.clientName} and would like to tighten the protection on ${input.domainName}. They need your approval before making the change.`,
      ...(input.note ? [`Their note: "${input.note}"`] : []),
      `What changes: ${input.effect}`,
      ...(input.trial ? [input.trial] : []),
      ...(input.evidence ? [`Why now: ${input.evidence}`] : []),
      `The risk: ${input.risk}`,
      `Approve or decline in your report. The request stays open until ${readableDate(input.expiresAt)}.`,
    ],
    action: { label: 'Review the request', url: input.url },
    aside:
      input.openPoints.length > 0
        ? {
            heading: `Points ${input.agencyName} has noted`,
            body: input.openPoints.join('\n'),
          }
        : null,
    footer: 'This message was sent because an IT provider listed this address as a contact who can approve changes for this domain.',
    brand: input.brand,
    whiteLabel: true,
  });
}

/** Tells the agency what the client decided. Agency facing, so DMARC Harbor's brand. */
export function policyProposalDecidedEmail(input: {
  workspaceName: string;
  title: string;
  body: string;
  url: string;
}): RenderedEmail {
  return layout({
    title: input.title,
    preheader: input.body.slice(0, 140),
    heading: input.title,
    paragraphs: [input.body],
    action: { label: 'Open the domain', url: input.url },
    footer: `You are receiving this because you proposed this change, or own or administer ${input.workspaceName}.`,
  });
}

/**
 * A digest of the DNS changes found in one monitoring pass.
 *
 * One email per workspace recipient per pass, rather than one per change: a
 * shared SPF include can change on fifty domains at once, and fifty emails is
 * how a customer learns to filter this address.
 */
export function dnsChangesEmail(input: {
  workspaceName: string;
  appUrl: string;
  changes: Array<{ domainName: string; domainSlug: string; summary: string }>;
}): RenderedEmail {
  const count = input.changes.length;
  const domains = new Set(input.changes.map((change) => change.domainName)).size;
  const subject = `DNS changed on ${domains} domain${domains === 1 ? '' : 's'} in ${input.workspaceName}`;

  return layout({
    title: subject,
    preheader: `${count} DNS change${count === 1 ? '' : 's'} recorded for ${input.workspaceName}.`,
    heading: subject,
    paragraphs: [
      `We re-read public DNS for ${input.workspaceName} and found ${count} change${count === 1 ? '' : 's'}.`,
      ...input.changes.map(
        (change) =>
          `${change.domainName}: ${change.summary} (${input.appUrl}/domains/${change.domainSlug})`,
      ),
      'Review each change in DMARC Harbor. If a change was intentional, acknowledge it so the history records that someone has seen it.',
    ],
    action: { label: 'Review the DNS history', url: `${input.appUrl}/clients` },
    footer: 'You are receiving this because you own or administer this DMARC Harbor workspace.',
  });
}

/**
 * Domain registrations that expire soon, or have expired, in one workspace.
 *
 * Each line is the same sentence the in-app notice and the chat post carry,
 * built once by the expiry service, so the three channels cannot disagree
 * about a date.
 */
export function domainExpiryEmail(input: {
  workspaceName: string;
  appUrl: string;
  domains: Array<{ domainSlug: string; sentence: string; registrar: string | null }>;
}): RenderedEmail {
  const count = input.domains.length;
  const subject =
    count === 1
      ? `A domain registration needs renewing in ${input.workspaceName}`
      : `${count} domain registrations need renewing in ${input.workspaceName}`;

  return layout({
    title: subject,
    preheader: input.domains[0]?.sentence ?? subject,
    heading: subject,
    paragraphs: [
      ...input.domains.map(
        (entry) =>
          `${entry.sentence}${entry.registrar ? ` Registrar: ${entry.registrar}.` : ''} (${input.appUrl}/domains/${entry.domainSlug})`,
      ),
      'When a registration lapses the domain stops resolving: mail to and from it fails, its DMARC, SPF and DKIM records disappear with it, and DMARC reports stop arriving.',
      'Renew it with the registrar, or check that auto-renew is on and the card on file is current. The date comes from the registry over RDAP and is re-read every day, so a renewal shows here within a day.',
    ],
    action: { label: 'Open DMARC Harbor', url: `${input.appUrl}/domains/${input.domains[0]?.domainSlug ?? ''}` },
    footer: 'You are receiving this because you own or administer this DMARC Harbor workspace.',
  });
}

/**
 * The email that delivers a monthly report.
 *
 * It carries a link, not an attachment. The report is stored and fingerprinted;
 * an attachment would be a second copy with no fingerprint attached to it, and
 * a client forwarding it would have no reference to check.
 */
export function monthlyReportEmail(input: {
  brand: BrandLook;
  branded: boolean;
  agencyName: string;
  clientName: string;
  periodLabel: string;
  messages: number;
  passRate: string;
  domainsAtReject: number;
  downloadUrl: string;
  reference: string;
  verifyUrl: string;
}): RenderedEmail {
  const subject = `${input.clientName} email authentication report, ${input.periodLabel}`;
  const totals =
    input.messages > 0
      ? `${input.clientName}'s domains received ${input.messages.toLocaleString('en-GB')} messages in ${input.periodLabel}. ${input.passRate} passed DMARC, and ${input.domainsAtReject} domain${input.domainsAtReject === 1 ? '' : 's'} were at reject at the end of the month.`
      : `No aggregate reports were received for ${input.clientName}'s domains in ${input.periodLabel}.`;

  return layout({
    title: subject,
    preheader: `The ${input.periodLabel} email authentication report for ${input.clientName} is ready.`,
    heading: subject,
    paragraphs: [
      totals,
      `Download the report: ${input.downloadUrl}`,
      `Document reference: ${input.reference}`,
      `Verify the file at ${input.verifyUrl}`,
    ],
    action: { label: 'Download the report', url: input.downloadUrl },
    footer: input.branded
      ? `You are receiving this because ${input.agencyName} prepared a monthly report for ${input.clientName}.`
      : `You are receiving this because a monthly report was prepared for ${input.clientName} using DMARC Harbor.`,
    brand: input.brand,
    whiteLabel: input.branded,
  });
}

export function domainVerificationNotice(input: {
  workspaceName: string;
  domainName: string;
  verified: boolean;
  appUrl: string;
}): RenderedEmail {
  return input.verified
    ? layout({
        title: `${input.domainName} is now verified`,
        preheader: `DMARC reports for ${input.domainName} will start arriving shortly.`,
        heading: `${input.domainName} is now verified`,
        paragraphs: [
          `We confirmed the ownership record for ${input.domainName}, so DMARC reports sent to us will be collected from now on.`,
          'It can take up to 24 hours for the first reports to arrive, and up to a week for a full picture of your sending sources.',
        ],
        action: { label: 'View domain', url: input.appUrl },
        footer: 'You are receiving this because you added this domain in DMARC Harbor.',
      })
    : layout({
        title: `${input.domainName} lost its verification`,
        preheader: 'The DNS ownership record is no longer present, so reports are being rejected.',
        heading: `${input.domainName} is no longer verified`,
        paragraphs: [
          `We can no longer find the ownership record for ${input.domainName}. Until it is restored, DMARC reports for this domain are being rejected and your reporting has a gap.`,
          'This usually means a DNS record was removed, or a DNS provider was changed without re-adding the record.',
        ],
        action: { label: 'Restore verification', url: input.appUrl },
        footer: 'You are receiving this because you added this domain in DMARC Harbor.',
      });
}

export function paymentFailedEmail(input: {
  workspaceName: string;
  planLabel: string;
  graceEndsAt: string;
  billingUrl: string;
}): RenderedEmail {
  return layout({
    title: `Payment failed for ${input.planLabel}`,
    // The payment provider retries the card, not this service; the copy says so.
    preheader: 'Your payment provider will retry the charge. Update your card to avoid losing access.',
    heading: `We could not take payment for ${input.planLabel}`,
    paragraphs: [
      `Your last payment for ${input.planLabel} did not go through. Your payment provider retries the charge on its own once the card works.`,
      `Your access continues until ${readableDate(input.graceEndsAt)}. If the payment still has not succeeded by then, the workspace moves to the free plan.`,
      'All of your clients, domains and reports are kept either way. Nothing is deleted, and updating your card restores your previous plan immediately.',
    ],
    action: { label: 'Update payment method', url: input.billingUrl },
    aside: {
      heading: 'Nothing is lost',
      body: 'A failed payment never deletes client data. The workspace drops to the free plan, and your full history comes back when you upgrade.',
    },
    footer: 'You are receiving this because you have a paid subscription in DMARC Harbor.',
  });
}

export function subscriptionCancelledEmail(input: {
  workspaceName: string;
  planLabel: string;
  accessUntil: string;
  billingUrl: string;
}): RenderedEmail {
  return layout({
    title: `Your ${input.planLabel} subscription is ending`,
    preheader: `Access continues until ${readableDate(input.accessUntil)}.`,
    heading: `Your ${input.planLabel} subscription will not renew`,
    paragraphs: [
      `As requested, your ${input.planLabel} subscription is set to end. You keep full access until ${readableDate(input.accessUntil)}, and nothing is deleted.`,
      'Changed your mind? You can keep your plan and every feature you had by resuming before that date.',
    ],
    action: { label: 'Keep my plan', url: input.billingUrl },
    footer: 'You are receiving this because you have a paid subscription in DMARC Harbor.',
  });
}

export function planChangedEmail(input: {
  workspaceName: string;
  fromLabel: string;
  toLabel: string;
  effectiveAt: string;
  /**
   * `immediate` when the provider applied the change at once and adjusted the
   * charge (Paddle); `cycle_end` when it takes effect at the end of the paid
   * period with no mid-cycle charge (Razorpay). The two need different words:
   * one email used to promise "no mid-cycle amount" to both.
   */
  timing: 'immediate' | 'cycle_end';
  billingUrl: string;
}): RenderedEmail {
  const immediate = input.timing === 'immediate';
  return layout({
    title: immediate ? `Your plan is now ${input.toLabel}` : `Your plan changes to ${input.toLabel}`,
    preheader: immediate ? 'Effective now.' : `Effective ${readableDate(input.effectiveAt)}.`,
    heading: immediate ? `Your plan is now ${input.toLabel}` : `Your plan changes to ${input.toLabel}`,
    paragraphs: immediate
      ? [
          `Your plan moved from ${input.fromLabel} to ${input.toLabel} on ${readableDate(input.effectiveAt)}, and the ${input.toLabel} limits apply from now.`,
          'The payment provider adjusts the charge for the rest of the current period: a move up is billed for the difference, a move down is credited.',
        ]
      : [
          `Your plan moves from ${input.fromLabel} to ${input.toLabel} on ${readableDate(input.effectiveAt)}, at the end of the period you have already paid for.`,
          'You are not charged a mid-cycle amount, and your current limits stay in place until the change takes effect.',
        ],
    action: { label: 'Manage plan', url: input.billingUrl },
    footer: 'You are receiving this because you have a paid subscription in DMARC Harbor.',
  });
}

export function exportReadyEmail(input: {
  workspaceName: string;
  scopeLabel: string;
  downloadUrl: string;
  expiresAt: string;
}): RenderedEmail {
  return layout({
    title: 'Your data export is ready',
    preheader: 'Download it before the link expires.',
    heading: 'Your data export is ready',
    paragraphs: [
      `The ${input.scopeLabel} export you requested is ready to download. The link expires on ${readableDate(input.expiresAt)}, after which a new export must be requested.`,
      'The export excludes credentials and secrets. Access tokens and API keys are never included.',
    ],
    action: { label: 'Download export', url: input.downloadUrl },
    footer: 'You are receiving this because you requested a data export in DMARC Harbor.',
  });
}

export function erasureScheduledEmail(input: {
  workspaceName: string;
  scopeLabel: string;
  executesAt: string;
  cancelUrl: string;
}): RenderedEmail {
  return layout({
    title: 'Your data deletion is scheduled',
    preheader: `You can cancel it until ${readableDate(input.executesAt)}.`,
    heading: 'Your data deletion is scheduled',
    paragraphs: [
      `The ${input.scopeLabel} deletion you requested will run on ${readableDate(input.executesAt)}. You can cancel it any time before then, and nothing has been removed yet.`,
      'The audit and billing records needed to show what happened are kept in an anonymised form.',
    ],
    action: { label: 'Cancel deletion', url: input.cancelUrl },
    footer: 'You are receiving this because you requested a deletion in DMARC Harbor.',
  });
}

export function erasureCompletedEmail(input: {
  workspaceName: string;
  scopeLabel: string;
  completedAt: string;
}): RenderedEmail {
  return layout({
    title: 'Your data deletion is complete',
    preheader: `${input.scopeLabel} has been removed.`,
    heading: 'Your data deletion is complete',
    paragraphs: [
      `The ${input.scopeLabel} deletion finished on ${readableDate(input.completedAt)}. Client records, domains, and DMARC reports in scope have been removed.`,
      'Records that exist to evidence the deletion itself are retained in an anonymised form. A copy of that record is available in your workspace.',
    ],
    footer: 'You are receiving this because you requested a deletion in DMARC Harbor.',
  });
}
