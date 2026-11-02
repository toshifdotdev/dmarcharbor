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
 *
 * The look is the product's "Routes" design, the same one the web app uses: a
 * white page, near-black type, and colour only where it carries meaning. In an
 * email that means one hairline under the masthead and one above the footer, a
 * pill for the one action, and red only on mail about something that failed.
 * The markup is tables and inline styles because that is what Gmail, Outlook
 * desktop and Apple Mail all render; no web font is loaded (see `fontStack`).
 *
 * This module imports nothing. The email transport imports it, so a value
 * import in the other direction would be a cycle.
 */

export interface BrandLook {
  workspaceName: string;
  logoUrl?: string | null;
  primaryColor?: string | null;
  /**
   * The colour of the text set ON the primary colour, not a second accent. The
   * field kept its old name; the web settings label it "Text on the brand
   * colour". Empty means black or white is chosen for contrast.
   */
  accentColor?: string | null;
}

/* The Routes tokens, by the names .kiro/steering/design-system.md uses. */
const ink = '#15171b';
const ink2 = '#41454d';
const ink3 = '#6c717a';
const rule = '#e7e9ed';
const rule2 = '#c9cdd4';
const red = '#d9342b';
const white = '#ffffff';

/**
 * Albert Sans first, for the readers who have it installed, then each
 * platform's own sans. It is deliberately not loaded from Google Fonts or any
 * other host: a remote font request hands every recipient's IP address, and the
 * moment they opened the message, to a third party. The product refuses to do
 * that for agency logos (see `resolveBranding`), and a typeface is no better a
 * reason.
 */
const fontStack = "'Albert Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/** For literal values a reader copies exactly: domains, records, references, links. */
const monoStack = "'Atkinson Hyperlegible Mono',ui-monospace,'Cascadia Mono',Consolas,monospace";

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

/*
 * The contrast arithmetic, copied from apps/web/lib/brand-vars.ts rather than
 * imported, because the two apps share no code at runtime. It has to agree with
 * the web's, so the button an agency approved in its white-label preview is the
 * button its clients get in their inbox. The one difference is the dark ink,
 * which is the Routes ink here.
 */

function luminance(hex: string): number {
  const channel = (offset: number) => {
    const v = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** WCAG contrast ratio between two #rrggbb colours, 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Ink or white, whichever reads better on the given #rrggbb. */
export function contrastInk(hex: string): string {
  return contrastRatio(hex, white) >= contrastRatio(hex, ink) ? white : ink;
}

interface MailColours {
  /** The primary action's fill. */
  button: string;
  /** The label on that fill. */
  buttonText: string;
  /** Links in the copy and in the contact line, on the white page. */
  link: string;
}

/**
 * Our own mail is ink: an ink pill with white text, and ink links. Client mail
 * under white label takes the agency's primary colour for the pill, with the
 * agency's "text on the brand colour" when it set a valid one and otherwise ink
 * or white by contrast, as BrandApplier does on its pages. Links take the
 * primary only when it reads at 4.5:1 on white, the bar the white-label screen
 * measures under "Links on the white page"; a pale brand colour would make
 * every link in the message unreadable, so those stay ink.
 *
 * A text colour with no primary colour is ignored: it was chosen to sit on the
 * agency's colour, and on our ink it may not be readable at all.
 */
function mailColours(brand: BrandLook | null | undefined, whiteLabel: boolean): MailColours {
  const primary = whiteLabel ? safeColour(brand?.primaryColor, '') : '';
  if (!primary) {
    return { button: ink, buttonText: white, link: ink };
  }
  const onPrimary = safeColour(brand?.accentColor, '') || contrastInk(primary);
  return {
    button: primary,
    buttonText: onPrimary,
    link: contrastRatio(primary, white) >= 4.5 ? primary : ink,
  };
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

/**
 * The contact an agency publishes to its clients, shown on its client mail as
 * one line above the footer. Only ever the agency's own support address and
 * page from its white label settings, never a staff member's sign-in address.
 */
export interface ContactLine {
  agencyName: string;
  email?: string | null;
  url?: string | null;
}

/** Re-checked here because a template is the last step before a client reads it. */
function usableContactEmail(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return /^[^\s@"<>,;()\\[\]]+@[^\s@"<>,;()\\[\]]+$/.test(trimmed) ? trimmed : null;
}

function usableContactUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password ? parsed.toString() : null;
  } catch {
    return null;
  }
}

/**
 * "Questions? Contact Wistholm IT at help@wistholm.example or
 * https://wistholm.example/help." with whichever parts exist, or null when the
 * agency has published neither. The plain text form; the HTML form is built in
 * `layout` from the same parts.
 */
export function contactSentence(contact: ContactLine | null | undefined): string | null {
  if (!contact) return null;
  const email = usableContactEmail(contact.email);
  const url = usableContactUrl(contact.url);
  const name = contact.agencyName.replace(/[\r\n]+/g, ' ').trim();
  if (!name || (!email && !url)) return null;
  const ways = [email, url].filter((part): part is string => Boolean(part)).join(' or ');
  return `Questions? Contact ${name} at ${ways}.`;
}

/**
 * The contact line for a client facing message, from the resolved branding.
 * Null below white label, where the support fields are not presented at all,
 * and when the agency has published neither an address nor a page.
 */
export function clientContact(
  branding: { branded: boolean; workspaceName: string; supportEmail?: string | null; supportUrl?: string | null } | null | undefined,
): ContactLine | null {
  if (!branding?.branded || (!branding.supportEmail && !branding.supportUrl)) {
    return null;
  }
  return { agencyName: branding.workspaceName, email: branding.supportEmail ?? null, url: branding.supportUrl ?? null };
}

/**
 * The HTML form of `contactSentence`. Each link opens with its href, because
 * a client that strips styles still has to find the address.
 */
function contactHtml(contact: ContactLine | null | undefined, linkColour: string): string {
  if (!contactSentence(contact) || !contact) return '';
  const email = usableContactEmail(contact.email);
  const url = usableContactUrl(contact.url);
  const ways = [
    email
      ? `<a href="mailto:${escapeHtml(email)}" style="color:${linkColour};text-decoration:underline;">${escapeHtml(email)}</a>`
      : null,
    url
      ? `<a href="${escapeHtml(url)}" style="color:${linkColour};text-decoration:underline;word-break:break-all;">${escapeHtml(url)}</a>`
      : null,
  ]
    .filter(Boolean)
    .join(' or ');
  const name = escapeHtml(contact.agencyName.replace(/[\r\n]+/g, ' ').trim());
  return `<p style="margin:28px 0 0;font-family:${fontStack};font-size:15px;line-height:1.55;color:${ink2};">Questions? Contact ${name} at ${ways}.</p>`;
}

/* ------------------------------------------------------------- the pieces */

/** A state word and its shape, shown above the heading. */
export interface EmailState {
  tone: 'ok' | 'warn' | 'fail' | 'void';
  word: string;
}

/** One line of a two-column list: what it is, and its value. */
export interface EmailFact {
  label: string;
  value: string;
  /** A literal the reader may copy exactly: a reference, an address, a record. */
  mono?: boolean;
  href?: string | null;
}

/** One entry of a list, such as each domain a DNS pass found changed. */
export interface EmailRow {
  name: string;
  /** True when the name is a literal, such as a domain. */
  mono?: boolean;
  detail: string;
  href?: string | null;
}

/**
 * Each state's shape and colours. The shape is a text character, so it reaches
 * every client (no SVG, no images to block), and the word always travels with
 * it, so a state never rests on colour alone. Red is the failed state's only.
 */
const stateLooks: Record<EmailState['tone'], { mark: string; markColour: string; wordColour: string }> = {
  ok: { mark: '&#9632;', markColour: '#0f7a3b', wordColour: '#0f7a3b' },
  warn: { mark: '&#9679;', markColour: '#c58a14', wordColour: '#9a5b00' },
  fail: { mark: '&#9670;', markColour: red, wordColour: red },
  void: { mark: '&#9675;', markColour: ink3, wordColour: ink3 },
};

function stateHtml(state: EmailState | null | undefined): string {
  if (!state) return '';
  const look = stateLooks[state.tone];
  return `<p style="margin:0 0 10px;font-family:${fontStack};font-size:14px;font-weight:600;line-height:1.4;color:${look.wordColour};"><span aria-hidden="true" style="color:${look.markColour};">${look.mark}</span>&nbsp;&nbsp;${escapeHtml(state.word)}</p>`;
}

const urlPattern = /https?:\/\/[^\s<>"']+/g;

/** A URL's trailing punctuation belongs to the sentence around it. */
function trimUrl(raw: string): string {
  let url = raw;
  while (url.length > 0) {
    const last = url.charAt(url.length - 1);
    if ('.,;:!?'.includes(last) || (last === ')' && !url.includes('('))) {
      url = url.slice(0, -1);
    } else {
      break;
    }
  }
  return url;
}

/** Escapes a run of copy, and makes each http(s) address in it an ink, underlined link. */
function linkedText(value: string, linkColour: string): string {
  let html = '';
  let from = 0;
  for (const match of value.matchAll(urlPattern)) {
    const at = match.index ?? 0;
    const url = trimUrl(match[0]);
    html += escapeHtml(value.slice(from, at));
    html += `<a href="${escapeHtml(url)}" style="color:${linkColour};text-decoration:underline;word-break:break-all;">${escapeHtml(url)}</a>`;
    from = at + url.length;
  }
  return html + escapeHtml(value.slice(from));
}

function paragraphHtml(paragraph: string, linkColour: string, marginBottom = 16): string {
  return `<p style="margin:0 0 ${marginBottom}px;font-family:${fontStack};font-size:16px;line-height:1.55;color:${ink2};">${linkedText(paragraph, linkColour).replace(/\n/g, '<br>')}</p>`;
}

/**
 * Lines set out in columns, kept in their columns, in mono.
 *
 * Each run of two or more spaces is read as a column break and the lines
 * become the rows of a table, rather than one block of preformatted text. The
 * owners' rollup pads its rows to about ninety characters, which is wider than
 * a 600px column at any readable size: as preformatted text the last column
 * wrapped under the first and the columns were lost, which is the one thing the
 * padding was there to give. A table keeps the columns and wraps within a cell.
 * A row with fewer columns (the "...and 3 more" line) spans the rest.
 */
function columnsHtml(lines: string[], linkColour: string, marginBottom: number): string {
  const rows = lines.map((line) => line.trim().split(/ {2,}/));
  const width = Math.max(...rows.map((cells) => cells.length));
  const body = rows
    .map((cells, index) => {
      const edge = index > 0 ? `border-top:1px solid ${rule};` : '';
      return `<tr>${cells
        .map((cell, position) => {
          const last = position === cells.length - 1;
          const span = last && cells.length < width ? ` colspan="${width - position}"` : '';
          // Only the last column may break inside a word. A domain or an IP
          // address in an earlier one is kept whole, or a narrow screen splits
          // it mid-token ("40.107.22." over "53").
          const breaking = last ? 'word-break:break-word;' : '';
          return `<td valign="top"${span} style="padding:5px ${last ? 0 : 16}px 5px 0;${edge}font-family:${monoStack};font-size:13px;line-height:1.5;color:${ink};white-space:pre-wrap;${breaking}">${linkedText(cell, linkColour)}</td>`;
        })
        .join('')}</tr>`;
    })
    .join('');
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin:0 0 ${marginBottom}px;">${body}</table>`;
}

function factsHtml(facts: EmailFact[] | null | undefined, linkColour: string): string {
  if (!facts?.length) return '';
  const rows = facts.map((fact, index) => {
    const lines = `border-top:1px solid ${rule};${index === facts.length - 1 ? `border-bottom:1px solid ${rule};` : ''}`;
    const face = fact.mono
      ? `font-family:${monoStack};font-size:14px;word-break:break-all;`
      : `font-family:${fontStack};font-size:15px;font-variant-numeric:tabular-nums;`;
    const value = fact.href
      ? `<a href="${escapeHtml(fact.href)}" style="color:${linkColour};text-decoration:underline;">${escapeHtml(fact.value)}</a>`
      : escapeHtml(fact.value);
    return `<tr><td valign="top" width="42%" style="width:42%;padding:11px 16px 11px 0;${lines}font-family:${fontStack};font-size:14px;line-height:1.45;color:${ink3};">${escapeHtml(fact.label)}</td><td valign="top" style="padding:11px 0;${lines}${face}line-height:1.45;color:${ink};">${value}</td></tr>`;
  });
  return `<div style="margin:8px 0 24px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;">${rows.join('')}</table></div>`;
}

function rowsHtml(rows: EmailRow[] | null | undefined, linkColour: string): string {
  if (!rows?.length) return '';
  const items = rows.map((row, index) => {
    const lines = `border-top:1px solid ${rule};${index === rows.length - 1 ? `border-bottom:1px solid ${rule};` : ''}`;
    const face = row.mono ? `font-family:${monoStack};font-size:14px;` : `font-family:${fontStack};font-size:15px;`;
    const name = row.href
      ? `<a href="${escapeHtml(row.href)}" style="color:${linkColour};text-decoration:underline;">${escapeHtml(row.name)}</a>`
      : escapeHtml(row.name);
    return `<tr><td style="padding:12px 0;${lines}"><p style="margin:0 0 3px;${face}font-weight:600;line-height:1.4;color:${ink};word-break:break-word;">${name}</p><p style="margin:0;font-family:${fontStack};font-size:15px;line-height:1.5;color:${ink2};">${linkedText(row.detail, linkColour).replace(/\n/g, '<br>')}</p></td></tr>`;
  });
  return `<div style="margin:8px 0 24px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;">${items.join('')}</table></div>`;
}

/**
 * The one action, as a pill: the link carries the padding, so the whole pill
 * is clickable. Outlook desktop draws it square, which is acceptable. A fill
 * too close to white gets a hairline so it still reads as a button.
 */
function actionHtml(action: { label: string; url: string }, colours: MailColours): string {
  const edge = contrastRatio(colours.button, white) < 1.5 ? `border:1px solid ${rule2};` : '';
  const url = escapeHtml(action.url);
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 16px;"><tr><td align="center" bgcolor="${colours.button}" style="border-radius:999px;background:${colours.button};${edge}"><a href="${url}" style="display:inline-block;padding:13px 26px;font-family:${fontStack};font-size:15px;font-weight:650;line-height:18px;color:${colours.buttonText};text-decoration:none;border-radius:999px;">${escapeHtml(action.label)}</a></td></tr></table>
    <p style="margin:0 0 4px;font-family:${fontStack};font-size:13px;line-height:1.5;color:${ink3};">If the button does not work, copy this link into your browser:</p>
    <p style="margin:0;font-family:${monoStack};font-size:13px;line-height:1.5;color:${ink2};word-break:break-all;">${url}</p>`;
}

/**
 * A note set apart by a rule down its left edge, not a tinted box. The rule is
 * ink, and red only when the note is about a failure.
 */
function asideHtml(aside: { heading: string; body: string; tone?: 'fail' }): string {
  const edge = aside.tone === 'fail' ? red : ink;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin:28px 0 0;"><tr><td style="padding:2px 0 2px 16px;border-left:3px solid ${edge};">
    <p style="margin:0 0 4px;font-family:${fontStack};font-size:15px;font-weight:700;line-height:1.4;color:${ink};">${escapeHtml(aside.heading)}</p>
    <p style="margin:0;font-family:${fontStack};font-size:15px;line-height:1.55;color:${ink2};">${escapeHtml(aside.body).replace(/\n/g, '<br>')}</p>
  </td></tr></table>`;
}

/**
 * The masthead: the agency's logo (only ever one served from our own origin,
 * which `resolveBranding` has already ensured) or the name in bold, then the
 * lighter kind of message beside it, as the map labels its stations.
 */
function mastheadHtml(name: string | null, kind: string | null, logo: string | null): string {
  const kindHtml = kind ? escapeHtml(kind) : '';
  if (logo) {
    return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td valign="middle" style="padding:0;"><img src="${escapeHtml(logo)}" alt="${escapeHtml(name ?? '')}" height="30" style="display:block;height:30px;max-height:30px;width:auto;border:0;outline:none;text-decoration:none;"></td>${
      kind
        ? `<td valign="middle" style="padding:0 0 0 12px;font-family:${fontStack};font-size:15px;line-height:1.3;color:${ink3};">${kindHtml}</td>`
        : ''
    }</tr></table>`;
  }
  if (!name) {
    return `<p style="margin:0;font-family:${fontStack};font-size:17px;line-height:1.3;font-weight:700;color:${ink};">${kindHtml}</p>`;
  }
  return `<p style="margin:0;font-family:${fontStack};font-size:17px;line-height:1.3;color:${ink};"><span style="font-weight:700;color:${ink};">${escapeHtml(name)}</span>${
    kind ? `&ensp;<span style="font-weight:400;color:${ink3};">${kindHtml}</span>` : ''
  }</p>`;
}

interface LayoutInput {
  title: string;
  preheader: string;
  heading: string;
  paragraphs: string[];
  /**
   * What the HTML shows in place of `paragraphs`, when `facts` or `rows` already
   * say what some of them say: `lead` above the lists, `close` below them. The
   * text part always keeps every paragraph, so a reader without HTML loses
   * nothing.
   */
  htmlCopy?: { lead: string[]; close?: string[] } | null;
  /**
   * The body as markup, in place of the paragraphs, given the link colour.
   * Built only inside this module (by `plainTextEmail`), from escaped text.
   */
  body?: ((linkColour: string) => string) | null;
  /** A two-column list, HTML only. */
  facts?: EmailFact[] | null;
  /** A list of named entries, HTML only. */
  rows?: EmailRow[] | null;
  action?: { label: string; url: string } | null;
  /** Rendered after the action, for example a code or a warning. `fail` draws its rule red. */
  aside?: { heading: string; body: string; tone?: 'fail' } | null;
  footer?: string | null;
  /** The lighter half of the masthead, saying what kind of message this is: "Billing". */
  kind?: string | null;
  /** A state word and its shape above the heading, for mail that reports one. */
  state?: EmailState | null;
  brand?: BrandLook | null;
  /** Client facing mail uses the agency's brand; agency mail does not. */
  whiteLabel?: boolean;
  /**
   * Names nobody in the masthead, only the kind of message, for mail whose
   * sender cannot be known when it is written.
   */
  neutral?: boolean;
  /**
   * The agency's published contact, as one line above the footer. Rendered
   * only on white label mail, so a staff template cannot carry it by mistake.
   */
  contact?: ContactLine | null;
  /**
   * The text part, when the message keeps one that is not built from the parts
   * above. The auth messages do: their text is what the seed script and the
   * tests read, and it predates this layout.
   */
  text?: string;
}

/**
 * Every message's HTML: a white page, a 600px column, the masthead and one
 * hairline, an optional state line, the heading, the copy, any lists, the one
 * action as a pill, an aside, the agency's contact line, and the footer under a
 * second hairline. Inline styles carry everything; the one <style> block only
 * narrows the side padding on a phone, for the clients that read it.
 */
function layout(input: LayoutInput): RenderedEmail {
  const useBrand = Boolean(input.whiteLabel && input.brand);
  const productName = input.neutral ? null : useBrand ? input.brand!.workspaceName : 'DMARC Harbor';
  const logo = useBrand && !input.neutral ? (input.brand!.logoUrl ?? null) : null;
  const colours = mailColours(input.brand, useBrand);

  const heading = input.heading;
  const contact = input.whiteLabel ? input.contact : null;
  const lead = input.htmlCopy ? input.htmlCopy.lead : input.paragraphs;
  const close = input.htmlCopy?.close ?? [];

  const body = [
    stateHtml(input.state),
    `<h1 style="margin:0 0 16px;font-family:${fontStack};font-size:26px;font-weight:700;line-height:1.15;letter-spacing:-0.02em;color:${ink};">${escapeHtml(heading)}</h1>`,
    input.body ? input.body(colours.link) : lead.map((paragraph) => paragraphHtml(paragraph, colours.link)).join('\n    '),
    factsHtml(input.facts, colours.link),
    rowsHtml(input.rows, colours.link),
    close.map((paragraph) => paragraphHtml(paragraph, colours.link)).join('\n    '),
    input.action ? actionHtml(input.action, colours) : '',
    input.aside ? asideHtml(input.aside) : '',
    contactHtml(contact, colours.link),
  ]
    .filter(Boolean)
    .join('\n    ');

  const footer = input.footer
    ? `<tr><td class="hb-side" style="padding:36px 24px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;"><tr><td style="padding:18px 0 0;border-top:1px solid ${rule};">
      <p style="margin:0;font-family:${fontStack};font-size:13px;line-height:1.55;color:${ink3};">${escapeHtml(input.footer)}</p>
    </td></tr></table>
  </td></tr>`
    : '';

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${escapeHtml(input.title)}</title>
<style>
:root { color-scheme: light; supported-color-schemes: light; }
@media only screen and (max-width: 480px) { .hb-side { padding-left: 16px !important; padding-right: 16px !important; } }
</style>
</head>
<body style="margin:0;padding:0;background:#ffffff;background-color:#ffffff;color:${ink};font-family:${fontStack};-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;">${escapeHtml(input.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="width:100%;background:#ffffff;background-color:#ffffff;">
<tr><td align="center" style="padding:0;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">
  <tr><td class="hb-side" style="padding:32px 24px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;"><tr><td style="padding:0 0 18px;border-bottom:1px solid ${rule};">
      ${mastheadHtml(productName, input.kind ?? null, logo)}
    </td></tr></table>
  </td></tr>
  <tr><td class="hb-side" style="padding:32px 24px 0;font-family:${fontStack};">
    ${body}
  </td></tr>
  ${footer}
  <tr><td style="padding:0 0 40px;font-size:0;line-height:0;">&nbsp;</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

  const text =
    input.text ??
    [
      heading,
      '',
      ...input.paragraphs.flatMap((paragraph) => [paragraph, '']),
      input.action ? `${input.action.label}: ${input.action.url}` : '',
      input.aside ? `${input.aside.heading}\n${input.aside.body}` : '',
      contactSentence(contact) ?? '',
      '',
      input.footer ?? '',
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
    kind: 'Team',
  });
}

export function portalAccessGranted(input: {
  brand: BrandLook;
  clientName: string;
  signInUrl: string;
  agencyName: string;
  /** The agency's published contact, when its white label is on. */
  contact?: ContactLine | null;
}): RenderedEmail {
  return layout({
    title: `You can now see DMARC reports for ${input.clientName}`,
    preheader: `${input.agencyName} has given you access to their DMARC reporting.`,
    heading: `You can now see DMARC reports for ${input.clientName}`,
    paragraphs: [
      `${input.agencyName} has given you access to the DMARC reporting for ${input.clientName}. You can see report volume, senders, and any spoofing warnings.`,
      // Contacts sign in with an email address and a password, so the copy says
      // how to get one. It used to promise there was no account and no
      // password, which sent people to a sign-in form with nothing to type.
      'Sign in with this email address to view it. The first time, choose Create an account and use this same address.',
      'This access is managed by your IT provider. If you did not expect it, you can ignore this message.',
    ],
    action: { label: 'View reports', url: input.signInUrl },
    footer: 'This message was sent because an IT provider added this address to a DMARC reporting account.',
    kind: 'Reporting access',
    brand: input.brand,
    whiteLabel: true,
    contact: input.contact ?? null,
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
  /** The agency's published contact, when its white label is on. */
  contact?: ContactLine | null;
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
    kind: 'Approval request',
    // Waiting on the reader, which the design draws as a ring.
    state: { tone: 'void', word: 'Waiting for your decision' },
    brand: input.brand,
    whiteLabel: true,
    contact: input.contact ?? null,
  });
}

/** Tells the agency what the client decided. Agency facing, so DMARC Harbor's brand. */
export function policyProposalDecidedEmail(input: {
  workspaceName: string;
  title: string;
  body: string;
  url: string;
  /** What the client decided, for the state line. Absent shows none. */
  decision?: 'approved' | 'declined' | null;
}): RenderedEmail {
  return layout({
    title: input.title,
    preheader: input.body.slice(0, 140),
    heading: input.title,
    paragraphs: [input.body],
    action: { label: 'Open the domain', url: input.url },
    footer: `You are receiving this because you proposed this change, or own or administer ${input.workspaceName}.`,
    kind: 'Approval request',
    // A decline is not a failure, so it is the quiet ring, not red.
    state:
      input.decision === 'approved'
        ? { tone: 'ok', word: 'Approved' }
        : input.decision === 'declined'
          ? { tone: 'void', word: 'Declined' }
          : null,
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

  const intro = `We re-read public DNS for ${input.workspaceName} and found ${count} change${count === 1 ? '' : 's'}.`;
  const review =
    'Review each change in DMARC Harbor. If a change was intentional, acknowledge it so the history records that someone has seen it.';

  return layout({
    title: subject,
    preheader: `${count} DNS change${count === 1 ? '' : 's'} recorded for ${input.workspaceName}.`,
    heading: subject,
    paragraphs: [
      intro,
      ...input.changes.map(
        (change) =>
          `${change.domainName}: ${change.summary} (${input.appUrl}/domains/${change.domainSlug})`,
      ),
      review,
    ],
    // The HTML lists the changes as rows, each domain linking to its page.
    htmlCopy: { lead: [intro], close: [review] },
    rows: input.changes.map((change) => ({
      name: change.domainName,
      mono: true,
      detail: change.summary,
      href: `${input.appUrl}/domains/${change.domainSlug}`,
    })),
    action: { label: 'Review the DNS history', url: `${input.appUrl}/clients` },
    footer: 'You are receiving this because you own or administer this DMARC Harbor workspace.',
    kind: 'DNS monitoring',
    state: { tone: 'warn', word: 'Changed' },
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
  domains: Array<{
    domainSlug: string;
    sentence: string;
    registrar: string | null;
    /** True once the registration has lapsed, which turns the state line red. */
    expired?: boolean;
  }>;
}): RenderedEmail {
  const count = input.domains.length;
  const subject =
    count === 1
      ? `A domain registration needs renewing in ${input.workspaceName}`
      : `${count} domain registrations need renewing in ${input.workspaceName}`;
  const explanation = [
    'When a registration lapses the domain stops resolving: mail to and from it fails, its DMARC, SPF and DKIM records disappear with it, and DMARC reports stop arriving.',
    'Renew it with the registrar, or check that auto-renew is on and the card on file is current. The date comes from the registry over RDAP and is re-read every day, so a renewal shows here within a day.',
  ];

  return layout({
    title: subject,
    preheader: input.domains[0]?.sentence ?? subject,
    heading: subject,
    paragraphs: [
      ...input.domains.map(
        (entry) =>
          `${entry.sentence}${entry.registrar ? ` Registrar: ${entry.registrar}.` : ''} (${input.appUrl}/domains/${entry.domainSlug})`,
      ),
      ...explanation,
    ],
    // Each sentence opens with its domain ("acme.com: The registration ..."),
    // so the HTML lifts the domain out as the row's name and links it.
    htmlCopy: { lead: [], close: explanation },
    rows: input.domains.map((entry) => {
      const split = entry.sentence.indexOf(': ');
      const name = split > 0 ? entry.sentence.slice(0, split) : entry.domainSlug;
      const sentence = split > 0 ? entry.sentence.slice(split + 2) : entry.sentence;
      return {
        name,
        mono: true,
        detail: `${sentence}${entry.registrar ? ` Registrar: ${entry.registrar}.` : ''}`,
        href: `${input.appUrl}/domains/${entry.domainSlug}`,
      };
    }),
    action: { label: 'Open DMARC Harbor', url: `${input.appUrl}/domains/${input.domains[0]?.domainSlug ?? ''}` },
    footer: 'You are receiving this because you own or administer this DMARC Harbor workspace.',
    kind: 'Domain registration',
    state: input.domains.some((entry) => entry.expired)
      ? { tone: 'fail', word: 'Expired' }
      : { tone: 'warn', word: 'Renewal due' },
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
  /** The agency's published contact. Shown only when `branded`. */
  contact?: ContactLine | null;
}): RenderedEmail {
  const subject = `${input.clientName} email authentication report, ${input.periodLabel}`;
  const totals =
    input.messages > 0
      ? `${input.clientName}'s domains received ${input.messages.toLocaleString('en-GB')} messages in ${input.periodLabel}. ${input.passRate} passed DMARC, and ${input.domainsAtReject} domain${input.domainsAtReject === 1 ? '' : 's'} were at reject at the end of the month.`
      : `No aggregate reports were received for ${input.clientName}'s domains in ${input.periodLabel}.`;

  const ready = `The ${input.periodLabel} email authentication report for ${input.clientName} is ready.`;

  return layout({
    title: subject,
    preheader: ready,
    heading: subject,
    paragraphs: [
      totals,
      `Download the report: ${input.downloadUrl}`,
      `Document reference: ${input.reference}`,
      `Verify the file at ${input.verifyUrl}`,
    ],
    // The HTML sets the month's figures and the reference out as a list, and
    // the button carries the download link; the text keeps the sentences.
    htmlCopy: { lead: [input.messages > 0 ? ready : totals] },
    facts: [
      ...(input.messages > 0
        ? [
            { label: 'Messages', value: input.messages.toLocaleString('en-GB') },
            { label: 'Passed DMARC', value: input.passRate },
            { label: 'Domains at reject at month end', value: String(input.domainsAtReject) },
          ]
        : []),
      { label: 'Document reference', value: input.reference, mono: true },
      { label: 'Verify the file at', value: input.verifyUrl, mono: true, href: input.verifyUrl },
    ],
    action: { label: 'Download the report', url: input.downloadUrl },
    kind: 'Monthly report',
    footer: input.branded
      ? `You are receiving this because ${input.agencyName} prepared a monthly report for ${input.clientName}.`
      : `You are receiving this because a monthly report was prepared for ${input.clientName} using DMARC Harbor.`,
    brand: input.brand,
    whiteLabel: input.branded,
    contact: input.branded ? (input.contact ?? null) : null,
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
        kind: 'Domain verification',
        state: { tone: 'ok', word: 'Verified' },
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
        kind: 'Domain verification',
        state: { tone: 'fail', word: 'Not verified' },
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
    kind: 'Billing',
    state: { tone: 'fail', word: 'Payment failed' },
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
    kind: 'Billing',
    state: { tone: 'warn', word: 'Not renewing' },
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
    kind: 'Billing',
  });
}

/**
 * What a downgrade left running that the new plan does not include, and what to
 * do about each. Sent only when there is something to act on.
 */
export function planPausedFeaturesEmail(input: {
  workspaceName: string;
  planLabel: string;
  /** One line per hosted record kind still served, e.g. "3 hosted DMARC records". */
  hostedRecords: string[];
  /** Enabled SSO connections, and the last day existing members can use them. */
  sso: { connections: number; signInUntil: string } | null;
  /** A verified custom domain that the new plan no longer serves. */
  customDomain?: string | null;
  appUrl: string;
  billingUrl: string;
}): RenderedEmail {
  const paragraphs: string[] = [
    `${input.workspaceName} is now on ${input.planLabel}. Nothing has been deleted, but some things you set up on your previous plan are no longer included.`,
  ];

  if (input.hostedRecords.length > 0) {
    paragraphs.push(
      `We still serve ${input.hostedRecords.join(', ')} for your domains, so your clients' mail keeps working. You can no longer change them. Move each record back to your own DNS from the domain's page with Stop hosting (Stop managing for SPF), or upgrade to keep editing them here.`,
    );
  }

  if (input.sso) {
    paragraphs.push(
      `Single sign-on is not included in ${input.planLabel}. Nobody new can join through your ${input.sso.connections === 1 ? 'connection' : `${input.sso.connections} connections`}. Existing members can keep signing in through it until ${readableDate(input.sso.signInUntil)}. After that they sign in with their email address and password; anyone who has never set a password can create one with Forgot password on the sign-in page.`,
    );
  }

  if (input.customDomain) {
    paragraphs.push(
      `Client pages on your own domain are not included in ${input.planLabel}, so ${input.customDomain} no longer shows your brand. Clients can still reach their portal and reports at our address, with your logo and colours where your plan includes them. You can remove the domain under Settings, White label.`,
    );
  }

  return layout({
    title: `What changes on ${input.planLabel}`,
    preheader: 'Nothing was deleted. A few things need your attention.',
    heading: `What changes on ${input.planLabel}`,
    paragraphs,
    action: { label: 'Open DMARC Harbor', url: input.appUrl },
    aside: { heading: 'Changed your mind?', body: `Upgrading again restores everything as it was. Plans are at ${input.billingUrl}.` },
    footer: 'You are receiving this because you own or administer this workspace in DMARC Harbor.',
    kind: 'Billing',
    state: { tone: 'warn', word: 'Needs your attention' },
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
    kind: 'Data export',
    state: { tone: 'ok', word: 'Ready' },
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
    kind: 'Deletion',
    state: { tone: 'warn', word: 'Scheduled' },
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
    kind: 'Deletion',
    state: { tone: 'ok', word: 'Deleted' },
  });
}

/* ------------------------------------------------- account and plain mail */

/**
 * An agency that a password reset or verification link was rebuilt for
 * (`auth/agency-auth-link.ts` decides when). Its name, already on one line, its
 * look when its white label is on, and the support address it publishes.
 */
export interface AuthEmailAgency {
  name: string;
  brand?: BrandLook | null;
  supportEmail?: string | null;
}

/**
 * Ends a reset or verification email sent in an agency's name with the support
 * address the agency publishes, so a client who is stuck knows who to ask. Only
 * when the link was rebuilt for the agency and it has published one.
 */
function withAgencyContact(text: string, agency: AuthEmailAgency | null | undefined): string {
  const line = agency && agency.supportEmail ? contactSentence({ agencyName: agency.name, email: agency.supportEmail }) : null;
  return line ? `${text}\n\n${line}` : text;
}

/** The parts of `layout` an agency's account mail shares: its look, its contact line. */
function agencyMail(agency: AuthEmailAgency | null | undefined) {
  if (!agency) {
    return { brand: null, whiteLabel: false, contact: null };
  }
  return {
    brand: { ...(agency.brand ?? {}), workspaceName: agency.name },
    whiteLabel: true,
    contact: agency.supportEmail ? { agencyName: agency.name, email: agency.supportEmail } : null,
  };
}

/**
 * A password reset link. In an agency's name, on its domain, when the reset
 * started there; otherwise ours. The text part is the one the integration
 * tests read the link from (the first URL in it), so it stays as it was.
 */
export function passwordResetEmail(input: { url: string; agency?: AuthEmailAgency | null }): RenderedEmail {
  const agency = input.agency ?? null;
  return layout({
    title: agency ? `Reset your password for ${agency.name}` : 'Reset your DMARC Harbor password',
    preheader: 'Choose a new password with the link in this email.',
    heading: 'Reset your password',
    paragraphs: ['We received a request to reset the password for this email address. Use the button to choose a new one.'],
    action: { label: 'Choose a new password', url: input.url },
    footer: 'If you did not request this, you can ignore this email.',
    kind: 'Account security',
    ...agencyMail(agency),
    text: withAgencyContact(
      `Reset your password using this link: ${input.url}\n\nIf you did not request this, you can ignore this email.`,
      agency,
    ),
  });
}

/**
 * An email verification link, with the same agency rule as the reset. The
 * unbranded text is what the web app's seed script reads from the console
 * provider ("Verify your email address using this link: ..."), so it is fixed.
 */
export function emailVerificationEmail(input: { url: string; agency?: AuthEmailAgency | null }): RenderedEmail {
  const agency = input.agency ?? null;
  return layout({
    title: agency ? `Verify your email for ${agency.name}` : 'Verify your DMARC Harbor email',
    preheader: 'Confirm this email address to finish setting up your account.',
    heading: 'Verify your email address',
    paragraphs: ['Confirm this email address to finish setting up your account.'],
    action: { label: 'Verify your email', url: input.url },
    footer: 'The link expires in 24 hours.',
    kind: 'Account security',
    ...agencyMail(agency),
    text: agency
      ? withAgencyContact(
          `Verify your email address for ${agency.name} using this link: ${input.url}\n\nThe link expires in 24 hours.`,
          agency,
        )
      : `Verify your email address using this link: ${input.url}\n\nThe link expires in 24 hours.`,
  });
}

/**
 * The warning to an existing account's owner that someone tried to sign up
 * with their address. It names no product in either part: a client on an
 * agency's own domain can trigger it, and the hook that sends it is not told
 * which host the attempt came from, so the masthead carries only the kind of
 * message and there is no button to a host that might be the wrong one.
 */
export function existingAccountSignUpEmail(): RenderedEmail {
  return layout({
    title: 'Someone tried to sign up with your email',
    preheader: 'If this was you, sign in instead.',
    heading: 'Someone tried to sign up with your email',
    paragraphs: [
      'Someone tried to create an account using this email address.',
      'If this was you, sign in instead. If not, you can ignore this email.',
    ],
    kind: 'Account security',
    neutral: true,
    text: 'Someone tried to create an account using this email address. If this was you, sign in instead. If not, you can ignore this email.',
  });
}

const securityNoticeFooter = 'If this was not you, reset your password and contact your workspace owner.';

/**
 * A notice that something changed on an account's sign-in: two-step
 * verification turned on or off or reset, a backup code used, new codes made.
 * The text is the notice and one fixed line under it, as it always was; the
 * HTML adds a way to the account's security page.
 */
export function securityNoticeEmail(input: { subject: string; notice: string; appUrl: string }): RenderedEmail {
  return layout({
    title: input.subject,
    preheader: input.notice.slice(0, 140),
    heading: input.subject,
    paragraphs: [input.notice],
    action: { label: 'Open account security', url: `${input.appUrl.replace(/\/+$/, '')}/account/security` },
    aside: { heading: 'If this was not you', body: 'Reset your password and contact your workspace owner.' },
    kind: 'Account security',
    text: `${input.notice}\n\n${securityNoticeFooter}`,
  });
}

/** A line set out in columns: two or more spaces between words. */
const alignedLine = /\S {2,}\S/;
/** A line indented by two or more spaces, as list items and table rows are. */
const indentedLine = /^ {2,}\S/;

/**
 * Plain text as Routes HTML. Paragraphs are split on blank lines and a single
 * newline is a line break. A run of indented lines that lines up in columns
 * (the alert rollup's table, a digest's top sources) is kept in its columns,
 * in mono; an indented run that does not is ordinary copy. One line with a
 * double space in it is not a table on its own unless it is indented, so a
 * sentence typed with two spaces after a full stop stays in the body face.
 *
 * `skip` is a paragraph the layout renders itself, the contact line, so it
 * does not appear twice.
 */
function textBodyHtml(text: string, linkColour: string, skip: string | null): string {
  const html: string[] = [];
  for (const block of text.replace(/\r\n?/g, '\n').split(/\n[ \t]*\n/)) {
    if (!block.trim() || (skip && block.trim() === skip)) continue;

    const lines = block.split('\n');
    const groups: Array<{ columns: boolean; lines: string[] }> = [];
    const addPlain = (line: string) => {
      const last = groups[groups.length - 1];
      if (last && !last.columns) last.lines.push(line);
      else groups.push({ columns: false, lines: [line] });
    };

    let index = 0;
    while (index < lines.length) {
      const line = lines[index]!;
      if (!indentedLine.test(line) && !alignedLine.test(line)) {
        addPlain(line.trim());
        index += 1;
        continue;
      }
      const run: string[] = [];
      while (index < lines.length && (indentedLine.test(lines[index]!) || alignedLine.test(lines[index]!))) {
        run.push(lines[index]!);
        index += 1;
      }
      const aligned = run.filter((entry) => alignedLine.test(entry));
      const columns = aligned.some((entry) => indentedLine.test(entry)) || aligned.length >= 2;
      if (columns) groups.push({ columns: true, lines: run });
      else run.forEach((entry) => addPlain(entry.trim()));
    }

    groups.forEach((group, position) => {
      // Parts of one paragraph sit close together; the paragraph ends with the usual space.
      const marginBottom = position === groups.length - 1 ? 16 : 6;
      html.push(
        group.columns
          ? columnsHtml(group.lines, linkColour, marginBottom)
          : paragraphHtml(group.lines.join('\n'), linkColour, marginBottom),
      );
    });
  }
  return html.join('\n    ');
}

/** "[DMARC Harbor] acme.com: Failure rate" reads as "acme.com: Failure rate" under a masthead that already names the sender. */
function headingFromSubject(subject: string): string {
  return subject.replace(/^\[[^\]]*\]\s*/, '') || subject;
}

/**
 * A message whose text is written elsewhere (an alert, a digest, a transport
 * fallback), dressed in the same layout as every template. The text part is
 * the given text, exactly; the HTML is that text set as paragraphs, with
 * http(s) addresses linked and column tables kept in their columns.
 *
 * When the text ends with the agency's contact line, pass `contact` too: the
 * HTML then shows that line with its links, in place of the plain paragraph.
 */
export function plainTextEmail(input: {
  subject: string;
  text: string;
  kind?: string | null;
  /** Defaults to the subject without a leading "[tag]". */
  heading?: string | null;
  /** Defaults to the first line of the text. */
  preheader?: string | null;
  brand?: BrandLook | null;
  whiteLabel?: boolean;
  contact?: ContactLine | null;
  action?: { label: string; url: string } | null;
  state?: EmailState | null;
  footer?: string | null;
}): RenderedEmail {
  const contact = input.whiteLabel ? (input.contact ?? null) : null;
  const skip = contactSentence(contact);
  const firstLine = input.text.split('\n').map((line) => line.trim()).find(Boolean) ?? input.subject;
  return layout({
    title: input.subject,
    preheader: input.preheader ?? firstLine.slice(0, 140),
    heading: input.heading ?? headingFromSubject(input.subject),
    paragraphs: [],
    body: (linkColour) => textBodyHtml(input.text, linkColour, skip),
    action: input.action ?? null,
    footer: input.footer ?? null,
    kind: input.kind ?? null,
    state: input.state ?? null,
    brand: input.brand ?? null,
    whiteLabel: input.whiteLabel ?? false,
    contact,
    text: input.text,
  });
}
