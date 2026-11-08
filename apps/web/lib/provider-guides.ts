/**
 * provider-guides.ts — how to set up SPF, DKIM and DMARC for the services an
 * MSP's clients send mail through, one guide each, rendered at /guides/<slug>.
 *
 * Every step and record here was checked against the provider's own
 * documentation in October 2026; each guide lists those pages under sources,
 * and its checkedOn says when. Providers change these screens, so the guides
 * name the menu path and the record shape, and always say to copy the exact
 * values the provider's console shows. Nothing here invents a value a provider
 * generates per account: those are written as <placeholders>.
 *
 * `spf` and `dkim` describe how the service's mail can pass DMARC, which is
 * what the route drawing on each guide shows: aligned (passes for the From
 * domain once set up), separate (passes, but for the service's own domain,
 * so it does not count for DMARC) or optional.
 */

export type CheckPath = "aligned" | "after-setup" | "not-aligned";

export interface GuideRecord {
  type: "TXT" | "CNAME" | "MX";
  host: string;
  value: string;
  note?: string;
}

export interface ProviderGuide {
  slug: string;
  name: string;
  /** The lighter kind, as a map labels a line. */
  kind: string;
  group: "mailbox" | "sender";
  /** One route colour per service, from the five line colours. */
  line: "blue" | "orange" | "green" | "yellow" | "purple";
  title: string;
  description: string;
  summary: string;
  spf: { path: CheckPath; note: string };
  dkim: { path: CheckPath; note: string };
  records: GuideRecord[];
  steps: Array<{ name: string; text: string }>;
  pitfalls: string[];
  sources: Array<{ label: string; url: string }>;
  checkedOn: string;
}

const DMARC_STEP = {
  name: "Publish a DMARC record",
  text: "At _dmarc.<your domain>, a TXT record starting at p=none with a report address, so you can see this service's mail pass before you enforce. The DMARC generator writes one.",
};

export const PROVIDER_GUIDES: ProviderGuide[] = [
  {
    slug: "microsoft-365",
    name: "Microsoft 365",
    kind: "staff mail",
    group: "mailbox",
    line: "blue",
    title: "SPF, DKIM and DMARC for Microsoft 365",
    description:
      "Set up SPF and DKIM for a custom domain in Microsoft 365 and Exchange Online: the SPF include, the two DKIM CNAME records and their 2025 format, and where to switch signing on in Microsoft Defender.",
    summary:
      "Microsoft 365 passes DMARC by SPF and by DKIM once both are set up. SPF is one include; DKIM is two CNAME records and a switch in the Defender portal, and it is off for custom domains until you turn it on.",
    spf: { path: "aligned", note: "include:spf.protection.outlook.com in the domain's SPF record" },
    dkim: { path: "after-setup", note: "off for custom domains until both CNAMEs are published and signing is enabled" },
    records: [
      { type: "TXT", host: "@", value: "v=spf1 include:spf.protection.outlook.com -all", note: "Add the include to the existing record if there is one: a domain has one SPF record." },
      {
        type: "CNAME",
        host: "selector1._domainkey",
        value: "selector1-<domain-with-dashes>._domainkey.<tenant>.<letter>-v1.dkim.mail.microsoft",
        note: "Domains added since May 2025. Older domains point at selector1-<domain-with-dashes>._domainkey.<tenant>.onmicrosoft.com instead.",
      },
      { type: "CNAME", host: "selector2._domainkey", value: "selector2-<domain-with-dashes>._domainkey.<tenant>.<letter>-v1.dkim.mail.microsoft" },
    ],
    steps: [
      { name: "Add the SPF include", text: "In the domain's DNS, make sure its one SPF record includes spf.protection.outlook.com. Microsoft recommends ending it with -all once DKIM and DMARC are in place." },
      {
        name: "Read the two DKIM values",
        text: "In the Microsoft Defender portal (security.microsoft.com), open Email & collaboration › Policies & rules › Threat policies › Email authentication settings › DKIM, and choose the custom domain, not the onmicrosoft.com one. Create DKIM keys if asked; the panel shows the two CNAME values. Get-DkimSigningConfig in Exchange Online PowerShell shows them too.",
      },
      { name: "Publish both CNAME records", text: "selector1._domainkey and selector2._domainkey, pointing exactly at the values shown. Copy them rather than typing: the letter before -v1 differs between domains." },
      { name: "Turn signing on", text: "Back on the DKIM tab, switch Sign messages for this domain with DKIM signatures on. Microsoft detects the CNAMEs first; that can take a while after publishing." },
      DMARC_STEP,
    ],
    pitfalls: [
      "Each subdomain that sends mail from Microsoft 365 needs its own SPF record and its own DKIM setup.",
      "Without the custom domain's own DKIM, mail is signed only by the onmicrosoft.com domain, which does not align with the From address.",
      "Do not flatten spf.protection.outlook.com into addresses: Microsoft changes them.",
    ],
    sources: [
      { label: "Microsoft: Set up SPF for Microsoft 365", url: "https://learn.microsoft.com/en-us/defender-office-365/email-authentication-spf-configure" },
      { label: "Microsoft: Set up DKIM for a custom domain", url: "https://learn.microsoft.com/en-us/defender-office-365/email-authentication-dkim-configure" },
    ],
    checkedOn: "October 2026",
  },
  {
    slug: "google-workspace",
    name: "Google Workspace",
    kind: "staff mail",
    group: "mailbox",
    line: "green",
    title: "SPF, DKIM and DMARC for Google Workspace",
    description:
      "Set up SPF and DKIM for Google Workspace (Gmail for business): the SPF include, generating the 2048-bit DKIM key in the Admin console, the google._domainkey TXT record and Start authentication.",
    summary:
      "Google Workspace passes DMARC by SPF and by DKIM once both are set up. SPF is one include; DKIM is a key you generate in the Admin console, publish as a TXT record, then switch on.",
    spf: { path: "aligned", note: "include:_spf.google.com in the domain's SPF record" },
    dkim: { path: "after-setup", note: "a key generated in the Admin console, published at google._domainkey, then started" },
    records: [
      { type: "TXT", host: "@", value: "v=spf1 include:_spf.google.com ~all", note: "Add the include to the existing record if there is one." },
      { type: "TXT", host: "google._domainkey", value: "v=DKIM1; k=rsa; p=<the key the Admin console shows>", note: "google is the default selector; use another if the domain already has a google key." },
    ],
    steps: [
      { name: "Add the SPF include", text: "Make sure the domain's one SPF record includes _spf.google.com. Nothing is set in the Admin console for SPF." },
      {
        name: "Generate the DKIM key",
        text: "In the Google Admin console open Apps › Google Workspace › Gmail › Authenticate email, choose the domain, then Generate New Record. Choose 2048 bits if the DNS host accepts it. Do not press Start authentication yet.",
      },
      { name: "Publish the key", text: "A TXT record at google._domainkey with the whole value shown, starting v=DKIM1. Some DNS hosts split long values into strings; that is fine." },
      { name: "Start authentication", text: "Back on Authenticate email, press Start authentication. It can take up to 48 hours to work; the page then says Authenticating email with DKIM." },
      DMARC_STEP,
    ],
    pitfalls: [
      "Each domain and alias domain needs its own DKIM key from the Admin console.",
      "A test message to yourself does not show DKIM; send one to another Gmail address and read the Authentication-Results header.",
    ],
    sources: [
      { label: "Google: Set up SPF", url: "https://knowledge.workspace.google.com/admin/security/set-up-spf" },
      { label: "Google: Set up DKIM", url: "https://knowledge.workspace.google.com/admin/security/set-up-dkim" },
    ],
    checkedOn: "October 2026",
  },
  {
    slug: "zoho-mail",
    name: "Zoho Mail",
    kind: "staff mail",
    group: "mailbox",
    line: "yellow",
    title: "SPF, DKIM and DMARC for Zoho Mail",
    description:
      "Set up SPF and DKIM for Zoho Mail: the zohomail.com SPF include, adding a DKIM selector in the Zoho Mail Admin Console, the TXT record, Verify and Enable.",
    summary:
      "Zoho Mail passes DMARC by SPF and by DKIM once both are set up. SPF is one include; DKIM is a selector you add in the Admin Console, publish, verify and enable.",
    spf: { path: "aligned", note: "include:zohomail.com in the domain's SPF record" },
    dkim: { path: "after-setup", note: "a selector added, published, verified and enabled in the Admin Console" },
    records: [
      { type: "TXT", host: "@", value: "v=spf1 include:zohomail.com ~all", note: "Zoho suggests include:one.zoho.com instead if several Zoho services send for the domain." },
      { type: "TXT", host: "<selector>._domainkey", value: "<the value the Admin Console shows>", note: "The selector is a name you choose, for example zoho." },
    ],
    steps: [
      { name: "Add the SPF include", text: "Make sure the domain's one SPF record includes zohomail.com, then verify it under Domains › Email Configuration › SPF." },
      {
        name: "Add a DKIM selector",
        text: "In the Zoho Mail Admin Console open Domains, choose the domain, then Email Configuration › DKIM › Add. Name the selector, choose 2048 bits, and copy the TXT value it shows.",
      },
      { name: "Publish the key", text: "A TXT record at <selector>._domainkey with that value. Some DNS hosts add the domain to the name for you." },
      { name: "Verify and enable", text: "Back in the Admin Console press Verify beside the selector, then enable DKIM so outgoing mail is signed." },
      DMARC_STEP,
    ],
    pitfalls: [
      "DKIM signing applies only to mail Zoho delivers directly; mail routed through an outbound gateway is not signed by Zoho.",
    ],
    sources: [
      { label: "Zoho: SPF configuration", url: "https://www.zoho.com/mail/help/adminconsole/spf-configuration.html" },
      { label: "Zoho: DKIM configuration", url: "https://www.zoho.com/mail/help/adminconsole/domain-keys-configuration.html" },
    ],
    checkedOn: "October 2026",
  },
  {
    slug: "mailchimp",
    name: "Mailchimp",
    kind: "newsletters",
    group: "sender",
    line: "yellow",
    title: "DKIM and DMARC for Mailchimp",
    description:
      "Authenticate a domain in Mailchimp so newsletters pass DMARC: the two DKIM CNAME records (k2 and k3), the DMARC record, and why SPF does not align for standard campaigns.",
    summary:
      "Mailchimp passes DMARC by DKIM. Its campaigns use Mailchimp's own bounce address, so SPF passes for Mailchimp's domain, not the client's, and does not count. Two CNAME records make DKIM sign as the client's domain.",
    spf: { path: "not-aligned", note: "passes for Mailchimp's bounce domain, which is not the From domain" },
    dkim: { path: "after-setup", note: "two CNAME records from Account & billing › Domains" },
    records: [
      { type: "CNAME", host: "k2._domainkey", value: "dkim2.mcsv.net" },
      { type: "CNAME", host: "k3._domainkey", value: "dkim3.mcsv.net" },
    ],
    steps: [
      { name: "Verify the sending address", text: "Mailchimp first verifies an address at the domain, by a link or code it emails." },
      { name: "Start authentication", text: "Open Account & billing › Domains and choose Start authentication beside the domain. Choose the DNS host; Mailchimp offers to publish the records for you through Entri, or shows them to add by hand." },
      { name: "Publish the two CNAMEs", text: "k2._domainkey and k3._domainkey, with the values Mailchimp shows. Enter only the part before the domain if the DNS host adds it." },
      { ...DMARC_STEP, text: "Mailchimp asks for a DMARC TXT record too. If the domain already has one, keep it: one DMARC record per domain." },
    ],
    pitfalls: [
      "Do not add a Mailchimp include to SPF for standard campaigns: it does not help DMARC and spends lookups.",
      "Changing the CNAMEs after authenticating can break it; turn authentication off in Mailchimp first.",
    ],
    sources: [
      { label: "Mailchimp: Set up email domain authentication", url: "https://mailchimp.com/help/set-up-email-domain-authentication/" },
      { label: "Mailchimp: About email domain authentication", url: "https://mailchimp.com/help/about-email-authentication/" },
    ],
    checkedOn: "October 2026",
  },
  {
    slug: "sendgrid",
    name: "SendGrid",
    kind: "app and transactional mail",
    group: "sender",
    line: "blue",
    title: "SPF, DKIM and DMARC for SendGrid",
    description:
      "Set up SendGrid domain authentication so app mail passes DMARC: Automated Security's CNAME records for the return path and the s1 and s2 DKIM selectors, and the DMARC record.",
    summary:
      "SendGrid passes DMARC by DKIM and by SPF once domain authentication is done. With Automated Security on (the default) you publish CNAME records and SendGrid maintains the SPF and DKIM behind them, on a subdomain of the client's domain.",
    spf: { path: "after-setup", note: "on the em<number> return-path subdomain SendGrid creates, which aligns with the domain" },
    dkim: { path: "after-setup", note: "selectors s1 and s2, as CNAME records SendGrid points at its keys" },
    records: [
      { type: "CNAME", host: "em<number>", value: "u<number>.wl<number>.sendgrid.net", note: "The return path. SendGrid shows the exact names and values." },
      { type: "CNAME", host: "s1._domainkey", value: "s1.domainkey.u<number>.wl<number>.sendgrid.net" },
      { type: "CNAME", host: "s2._domainkey", value: "s2.domainkey.u<number>.wl<number>.sendgrid.net" },
    ],
    steps: [
      { name: "Start domain authentication", text: "In SendGrid open Settings › Sender Authentication and, under Domain Authentication, Get Started. Choose the DNS host and enter the domain the From address uses." },
      { name: "Keep Automated Security on", text: "Under Advanced Settings leave Use automated security checked, unless the DNS host refuses underscores in CNAME names. Change the DKIM selector only if another service already uses s1 or s2." },
      { name: "Publish the records", text: "Add the CNAME records SendGrid shows. If the DNS host adds the domain itself, enter only the host part, such as em123." },
      { name: "Verify", text: "Back in SendGrid press Verify. DNS can take up to 48 hours." },
      DMARC_STEP,
    ],
    pitfalls: [
      "The root domain's SPF record does not need a SendGrid include when Automated Security is on.",
      "Subdomains do not inherit the authentication: mail from news.<domain> needs its own.",
    ],
    sources: [
      { label: "Twilio SendGrid: How to set up domain authentication", url: "https://www.twilio.com/docs/sendgrid/ui/account-and-settings/how-to-set-up-domain-authentication" },
      { label: "SendGrid: Use a custom DKIM selector", url: "https://support.sendgrid.com/hc/en-us/articles/4408024201627-Use-a-Custom-DKIM-Selector-for-Authentication" },
    ],
    checkedOn: "October 2026",
  },
  {
    slug: "hubspot",
    name: "HubSpot",
    kind: "marketing mail",
    group: "sender",
    line: "orange",
    title: "SPF, DKIM and DMARC for HubSpot",
    description:
      "Connect an email sending domain in HubSpot so marketing mail passes DMARC: the two DKIM CNAME records, the SPF include HubSpot gives, and the DMARC record.",
    summary:
      "HubSpot passes DMARC by DKIM: two CNAME records let it sign as the client's domain. It also asks for an SPF include, but on HubSpot's shared sending the bounce address is HubSpot's, so DKIM is what aligns.",
    spf: { path: "not-aligned", note: "HubSpot's include goes in the SPF record, but shared sending bounces to HubSpot's domain" },
    dkim: { path: "after-setup", note: "two CNAME records from Settings › Content › Domains & URLs › Email Sending" },
    records: [
      { type: "CNAME", host: "<hs1 host HubSpot shows>", value: "<value HubSpot shows>", note: "Two DKIM CNAME records; HubSpot generates both per account." },
      { type: "CNAME", host: "<hs2 host HubSpot shows>", value: "<value HubSpot shows>" },
      { type: "TXT", host: "@", value: "v=spf1 <existing includes> include:<number>.spf<number>.hubspotemail.net -all", note: "Add HubSpot's include to the existing record; never a second SPF record." },
    ],
    steps: [
      { name: "Connect the sending domain", text: "In HubSpot open Settings › Content › Domains & URLs › Email Sending and choose Connect sending domain. Enter an address you send marketing email from." },
      { name: "Publish the records", text: "Sign in to the DNS host through HubSpot if it offers it, or add the records by hand: two DKIM CNAMEs, the SPF include and a DMARC record." },
      { name: "Check the status", text: "Back on the Email Sending tab the domain reads Authenticated when DKIM, SPF and DMARC are all found. Partially authenticated means DKIM is done and SPF or DMARC is not yet seen." },
      DMARC_STEP,
    ],
    pitfalls: [
      "If the DNS is on Cloudflare, turn off CNAME flattening and the proxy for the HubSpot records.",
      "A subdomain's DMARC check is met by the root domain's DMARC record, which subdomains inherit.",
    ],
    sources: [{ label: "HubSpot: Manage your email authentication", url: "https://knowledge.hubspot.com/marketing-email/manage-email-authentication-in-hubspot" }],
    checkedOn: "October 2026",
  },
  {
    slug: "amazon-ses",
    name: "Amazon SES",
    kind: "app and transactional mail",
    group: "sender",
    line: "orange",
    title: "SPF, DKIM and DMARC for Amazon SES",
    description:
      "Set up Amazon SES so app mail passes DMARC: the three Easy DKIM CNAME records, a custom MAIL FROM subdomain with its MX and SPF records for SPF alignment, and the DMARC record.",
    summary:
      "Amazon SES passes DMARC by DKIM once Easy DKIM's three CNAMEs are published. SPF passes for amazonses.com by default, which does not align; a custom MAIL FROM subdomain makes SPF align too.",
    spf: { path: "after-setup", note: "aligns only with a custom MAIL FROM subdomain" },
    dkim: { path: "after-setup", note: "three Easy DKIM CNAME records" },
    records: [
      { type: "CNAME", host: "<token1>._domainkey", value: "<token1>.dkim.amazonses.com", note: "Three of these, one per token SES shows." },
      { type: "MX", host: "<mail-from subdomain>", value: "10 feedback-smtp.<region>.amazonses.com", note: "Only for a custom MAIL FROM domain, such as bounce.<domain>." },
      { type: "TXT", host: "<mail-from subdomain>", value: "v=spf1 include:amazonses.com ~all" },
    ],
    steps: [
      { name: "Create the domain identity", text: "In the SES console open Configuration › Identities and create a domain identity, in every AWS Region you send from. Easy DKIM is the default." },
      { name: "Publish the three DKIM CNAMEs", text: "Copy the three CNAME records the identity shows. SES verifies the domain and starts signing once it finds them." },
      { name: "Set a custom MAIL FROM domain", text: "On the identity, edit Custom MAIL FROM domain and choose a subdomain used for nothing else, such as bounce.<domain>. Publish the MX and SPF records it shows." },
      DMARC_STEP,
    ],
    pitfalls: [
      "The MAIL FROM subdomain must not be one you send from or receive mail at.",
      "An identity is per Region: a second Region needs its own records.",
    ],
    sources: [
      { label: "AWS: Using a custom MAIL FROM domain", url: "https://docs.aws.amazon.com/ses/latest/dg/mail-from.html" },
      { label: "AWS: Easy DKIM (verify-domain-dkim)", url: "https://docs.aws.amazon.com/cli/latest/reference/ses/verify-domain-dkim.html" },
    ],
    checkedOn: "October 2026",
  },
  {
    slug: "mailgun",
    name: "Mailgun",
    kind: "app and transactional mail",
    group: "sender",
    line: "purple",
    title: "SPF, DKIM and DMARC for Mailgun",
    description:
      "Verify a Mailgun sending domain so app mail passes DMARC: the SPF record, the DKIM record, the tracking CNAME and the MX records, on a sending subdomain such as mg.",
    summary:
      "Mailgun passes DMARC by DKIM and by SPF once the sending domain is verified. Use a subdomain such as mg.<domain>: its records then sit apart from the domain's own mail and still align.",
    spf: { path: "after-setup", note: "include:mailgun.org on the sending subdomain, which aligns with the domain" },
    dkim: { path: "after-setup", note: "the DKIM record from the domain's DNS settings in Mailgun" },
    records: [
      { type: "TXT", host: "mg", value: "v=spf1 include:mailgun.org ~all" },
      { type: "TXT", host: "<selector>._domainkey.mg", value: "<the value Mailgun shows>", note: "Or two CNAME records, with Automatic Sender Security." },
      { type: "CNAME", host: "email.mg", value: "mailgun.org", note: "Click and open tracking." },
      { type: "MX", host: "mg", value: "10 mxa.mailgun.org and 10 mxb.mailgun.org", note: "Only if Mailgun should receive mail at the subdomain." },
    ],
    steps: [
      { name: "Add a sending subdomain", text: "In Mailgun add a domain such as mg.<domain> rather than the domain itself, so its MX and SPF never touch the domain's own mail." },
      { name: "Publish the records", text: "Copy the records from the domain's DNS settings in Mailgun: SPF, DKIM, the tracking CNAME, and the MX records if Mailgun should receive mail." },
      { name: "Verify", text: "Press Verify DNS settings, or wait for Mailgun to check. DNS can take 24 to 48 hours." },
      DMARC_STEP,
    ],
    pitfalls: [
      "Mailgun may list more than one DKIM key; only the one in use has to verify.",
      "With relaxed alignment, mail sent as you@<domain> through mg.<domain> still aligns for SPF and DKIM.",
    ],
    sources: [
      { label: "Mailgun: Domain verification", url: "https://documentation.mailgun.com/docs/mailgun/user-manual/domains/" },
      { label: "Mailgun: Domain verification setup guide", url: "https://help.mailgun.com/hc/en-us/articles/32884702360603-Domain-Verification-Setup-Guide" },
    ],
    checkedOn: "October 2026",
  },
];

export const GUIDES_INDEX = {
  path: "/guides",
  title: "SPF, DKIM and DMARC setup guides by email provider",
  description:
    "Step-by-step SPF, DKIM and DMARC setup for Microsoft 365, Google Workspace, Zoho Mail, Mailchimp, SendGrid, HubSpot, Amazon SES and Mailgun, checked against each provider's own documentation.",
};

export const GUIDE_PATHS: string[] = [GUIDES_INDEX.path, ...PROVIDER_GUIDES.map((g) => `/guides/${g.slug}`)];

export function guideBySlug(slug: string): ProviderGuide | undefined {
  return PROVIDER_GUIDES.find((g) => g.slug === slug);
}

/** A guide as Markdown, for llms-full.txt and the assistant. */
export function guideMarkdown(guide: ProviderGuide): string {
  const lines = [`## ${guide.title}`, "", guide.summary, "", "Records:", ""];
  for (const r of guide.records) lines.push(`- ${r.type} ${r.host}: ${r.value}${r.note ? ` (${r.note})` : ""}`);
  lines.push("", "Steps:", "");
  guide.steps.forEach((s, i) => lines.push(`${i + 1}. ${s.name}. ${s.text}`));
  if (guide.pitfalls.length) {
    lines.push("", "Watch for:", "");
    for (const p of guide.pitfalls) lines.push(`- ${p}`);
  }
  lines.push("", `Checked against the provider's documentation in ${guide.checkedOn}: ${guide.sources.map((s) => s.url).join(", ")}`, "");
  return lines.join("\n");
}
