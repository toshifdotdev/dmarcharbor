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
    preheader: 'We will retry automatically. Update your card to avoid losing access.',
    heading: `We could not take payment for ${input.planLabel}`,
    paragraphs: [
      `Your last payment for ${input.planLabel} did not go through. We will retry automatically over the next few days.`,
      `Your access continues until ${input.graceEndsAt}. If the payment still has not succeeded by then, the workspace moves to the free plan.`,
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
    preheader: `Access continues until ${input.accessUntil}.`,
    heading: `Your ${input.planLabel} subscription will not renew`,
    paragraphs: [
      `As requested, your ${input.planLabel} subscription is set to end. You keep full access until ${input.accessUntil}, and nothing is deleted.`,
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
  billingUrl: string;
}): RenderedEmail {
  return layout({
    title: `Your plan changes to ${input.toLabel}`,
    preheader: `Effective ${input.effectiveAt}.`,
    heading: `Your plan changes to ${input.toLabel}`,
    paragraphs: [
      `Your plan moves from ${input.fromLabel} to ${input.toLabel} on ${input.effectiveAt}, at the end of the period you have already paid for.`,
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
      `The ${input.scopeLabel} export you requested is ready to download. The link expires on ${input.expiresAt}, after which a new export must be requested.`,
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
    preheader: `You can cancel it until ${input.executesAt}.`,
    heading: 'Your data deletion is scheduled',
    paragraphs: [
      `The ${input.scopeLabel} deletion you requested will run on ${input.executesAt}. You can cancel it any time before then, and nothing has been removed yet.`,
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
      `The ${input.scopeLabel} deletion finished on ${input.completedAt}. Client records, domains, and DMARC reports in scope have been removed.`,
      'Records that exist to evidence the deletion itself are retained in an anonymised form. A copy of that record is available in your workspace.',
    ],
    footer: 'You are receiving this because you requested a deletion in DMARC Harbor.',
  });
}
