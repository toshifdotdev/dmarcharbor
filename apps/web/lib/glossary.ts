/**
 * glossary.ts — the email authentication terms an MSP meets, once, in plain
 * words. Rendered at /glossary, linked from the free tools, and published in
 * llms-full.txt and as a DefinedTermSet, so every place says the same thing.
 *
 * Definitions follow the current standards: DMARC is RFC 9989 (which retired
 * pct, rf and ri and added t, np and psd), SPF RFC 7208, DKIM RFC 6376, ARC
 * RFC 8617, MTA-STS RFC 8461, TLS-RPT RFC 8460, null MX RFC 7505. BIMI is not
 * an RFC; its rules come from the BIMI Group's specification.
 *
 * Each term has a stable id: it is the page anchor (/glossary#alignment) the
 * tools link to, so an id is never renamed once published.
 */

export interface GlossaryTerm {
  id: string;
  /** Bold name, as written. */
  name: string;
  /** The lighter kind beside it. */
  kind: string;
  /** One or two plain sentences. */
  definition: string;
  /** A literal example, set in the data face. */
  example?: string;
  /** A free tool that checks this, by path. */
  tool?: string;
  /** Related term ids. */
  see?: string[];
}

export interface GlossaryGroup {
  id: string;
  name: string;
  kind: string;
  terms: GlossaryTerm[];
}

export const GLOSSARY: GlossaryGroup[] = [
  {
    id: "records",
    name: "The records",
    kind: "what a domain publishes in DNS",
    terms: [
      {
        id: "dmarc",
        name: "DMARC",
        kind: "Domain-based Message Authentication, Reporting and Conformance",
        definition:
          "A TXT record at _dmarc.<domain> that tells receiving mail servers what to do with mail that fails SPF and DKIM alignment, and where to send reports about the mail they saw. Defined in RFC 9989.",
        example: "_dmarc.pellowyn-dental.example  TXT  \"v=DMARC1; p=none; rua=mailto:dmarc@pellowyn-dental.example\"",
        tool: "/tools/dmarc",
        see: ["policy", "rua", "alignment"],
      },
      {
        id: "spf",
        name: "SPF",
        kind: "Sender Policy Framework",
        definition:
          "A TXT record on the domain listing the servers allowed to send mail with that domain in the envelope sender. A receiver checks the connecting server against it. Defined in RFC 7208.",
        example: "pellowyn-dental.example  TXT  \"v=spf1 include:spf.protection.outlook.com -all\"",
        tool: "/tools/spf",
        see: ["envelope-from", "spf-lookup-limit", "include"],
      },
      {
        id: "dkim",
        name: "DKIM",
        kind: "DomainKeys Identified Mail",
        definition:
          "A signature the sending service adds to each message, checked against a public key the domain publishes. It proves the message was signed by a holder of the domain's key and was not changed on the way. Defined in RFC 6376.",
        tool: "/tools/dkim",
        see: ["selector", "dkim-signature", "alignment"],
      },
      {
        id: "selector",
        name: "Selector",
        kind: "which DKIM key to use",
        definition:
          "The name a DKIM key is published under, so a domain can have several keys, one per sending service. The key lives at <selector>._domainkey.<domain>. DNS cannot list a domain's selectors; they are found in the s= tag of a message's DKIM-Signature header, or in DMARC reports.",
        example: "selector1._domainkey.pellowyn-dental.example",
        tool: "/tools/dkim",
        see: ["dkim", "dkim-signature"],
      },
      {
        id: "bimi",
        name: "BIMI",
        kind: "Brand Indicators for Message Identification",
        definition:
          "A TXT record at default._bimi.<domain> pointing at the brand's logo, so supporting mailbox providers can show it beside authenticated mail. It needs DMARC at quarantine or reject, and most large providers also need a certificate.",
        example: "default._bimi.pellowyn-dental.example  TXT  \"v=BIMI1; l=https://pellowyn-dental.example/logo.svg\"",
        tool: "/tools/bimi",
        see: ["vmc", "svg-tiny-ps"],
      },
      {
        id: "mta-sts",
        name: "MTA-STS",
        kind: "SMTP MTA Strict Transport Security",
        definition:
          "A TXT record and a policy file served over HTTPS that tell sending servers to deliver to the domain's mail servers only over verified TLS. It protects mail in transit rather than proving who sent it. Defined in RFC 8461.",
        see: ["tls-rpt", "mx"],
      },
      {
        id: "tls-rpt",
        name: "TLS-RPT",
        kind: "SMTP TLS Reporting",
        definition:
          "A TXT record at _smtp._tls.<domain> asking sending servers to report failed TLS connections to the domain. The partner of MTA-STS. Defined in RFC 8460.",
        example: "_smtp._tls.pellowyn-dental.example  TXT  \"v=TLSRPTv1; rua=mailto:tls@pellowyn-dental.example\"",
        see: ["mta-sts"],
      },
      {
        id: "mx",
        name: "MX record",
        kind: "where the domain receives mail",
        definition:
          "The DNS record naming the servers that accept mail for the domain. A domain that sends no mail and receives none can publish a null MX, a single MX of \".\" (RFC 7505).",
        example: "pellowyn-dental.example  MX  0 pellowyn-dental-example.mail.protection.outlook.com",
        see: ["mta-sts"],
      },
    ],
  },
  {
    id: "checks",
    name: "The checks",
    kind: "what a receiver works out for each message",
    terms: [
      {
        id: "envelope-from",
        name: "Envelope sender",
        kind: "MAIL FROM, Return-Path, RFC5321.MailFrom",
        definition:
          "The address the sending server gives before the message itself, where bounces go. SPF checks this domain. People rarely see it, and a service often sets it to its own domain.",
        example: "Return-Path: <bounces+12345@em.mailservice.example>",
        see: ["header-from", "spf", "alignment"],
      },
      {
        id: "header-from",
        name: "Header From",
        kind: "the From line people see, RFC5322.From",
        definition:
          "The address shown as the sender in a mail client. DMARC protects this domain: it asks whether SPF or DKIM passed for a domain that matches it.",
        example: "From: Pellowyn Dental <reminders@pellowyn-dental.example>",
        see: ["alignment", "envelope-from"],
      },
      {
        id: "dkim-signature",
        name: "DKIM-Signature",
        kind: "the header DKIM adds",
        definition:
          "The header a signing service adds to a message. Its d= tag names the signing domain and its s= tag the selector, which together say where the public key is.",
        example: "DKIM-Signature: v=1; a=rsa-sha256; d=pellowyn-dental.example; s=selector1; ...",
        see: ["dkim", "selector"],
      },
      {
        id: "alignment",
        name: "Alignment",
        kind: "the check DMARC adds",
        definition:
          "Whether the domain SPF or DKIM passed for matches the header From domain. Mail passes DMARC when SPF passes and aligns, or DKIM passes and aligns. A pass for some other domain does not count.",
        see: ["relaxed-alignment", "header-from", "dmarc-pass"],
      },
      {
        id: "relaxed-alignment",
        name: "Relaxed and strict alignment",
        kind: "adkim and aspf",
        definition:
          "Relaxed, the default, accepts a match on the organisational domain, so mail.pellowyn-dental.example aligns with pellowyn-dental.example. Strict needs the exact same name. Set per check with adkim=s and aspf=s.",
        example: "adkim=r; aspf=r",
        tool: "/tools/dmarc-generator",
        see: ["alignment", "organisational-domain"],
      },
      {
        id: "dmarc-pass",
        name: "DMARC pass",
        kind: "the verdict",
        definition:
          "A message passes DMARC when at least one of SPF and DKIM passes for a domain aligned with the header From. Otherwise it fails, and the receiver applies the published policy.",
        see: ["alignment", "policy"],
      },
      {
        id: "include",
        name: "include",
        kind: "an SPF mechanism",
        definition:
          "Pulls another domain's SPF record into this one, the usual way to authorise a service. Each include costs a DNS lookup, and so does everything inside it.",
        example: "include:_spf.google.com",
        tool: "/tools/spf",
        see: ["spf-lookup-limit"],
      },
      {
        id: "spf-lookup-limit",
        name: "The 10-lookup limit",
        kind: "SPF's permerror",
        definition:
          "A receiver stops after 10 DNS lookups while checking SPF (include, a, mx, ptr, exists and redirect each cost one, counted through every include) and returns a permanent error, so SPF fails for every message. More than 2 lookups that find nothing (void lookups) can fail it too.",
        tool: "/tools/spf",
        see: ["include", "spf-flattening"],
      },
      {
        id: "spf-flattening",
        name: "SPF flattening",
        kind: "a fix for too many lookups",
        definition:
          "Replacing includes with the address ranges they resolve to, so the record costs fewer lookups. The ranges change when a service changes them, so a flattened record has to be kept up to date, which is why it is usually managed by a service.",
        see: ["spf-lookup-limit"],
      },
      {
        id: "arc",
        name: "ARC",
        kind: "Authenticated Received Chain",
        definition:
          "Headers a forwarder or mailing list adds to record the authentication results it saw before it changed the message, so a later receiver can choose to trust them. Defined in RFC 8617.",
        see: ["forwarding"],
      },
    ],
  },
  {
    id: "policy",
    name: "The policy",
    kind: "what the DMARC record asks for",
    terms: [
      {
        id: "policy",
        name: "p=",
        kind: "the policy tag",
        definition:
          "What a receiver should do with mail that fails DMARC. none: deliver it as usual, and report. quarantine: treat it as suspicious, usually the spam folder. reject: refuse it. The usual path is none, then quarantine, then reject, once the reports show every real sender passing.",
        example: "p=none   p=quarantine   p=reject",
        tool: "/tools/dmarc",
        see: ["subdomain-policy", "testing-mode"],
      },
      {
        id: "subdomain-policy",
        name: "sp= and np=",
        kind: "policies for subdomains",
        definition:
          "sp sets the policy for subdomains that exist; without it they follow p. np sets it for subdomains that do not exist, which only a forger would send from.",
        example: "p=quarantine; sp=reject; np=reject",
        see: ["policy", "organisational-domain"],
      },
      {
        id: "testing-mode",
        name: "t=y",
        kind: "testing mode",
        definition:
          "Asks receivers to treat failing mail one step softer while a stronger policy is tried: quarantine as none, reject as quarantine. It replaced pct= in RFC 9989.",
        example: "p=reject; t=y",
        see: ["pct", "policy"],
      },
      {
        id: "pct",
        name: "pct=",
        kind: "retired",
        definition:
          "Once applied the policy to a percentage of failing mail. RFC 9989 retired it, along with rf= and ri=; newer receivers ignore it and apply p to all failing mail. Use t=y instead.",
        see: ["testing-mode"],
      },
      {
        id: "enforcement",
        name: "Enforcement",
        kind: "quarantine or reject",
        definition:
          "A DMARC policy that does something to failing mail. At p=none a domain is monitored but not protected: anyone can still send as it.",
        see: ["policy", "spoofing"],
      },
    ],
  },
  {
    id: "reports",
    name: "The reports",
    kind: "what receivers send back",
    terms: [
      {
        id: "rua",
        name: "rua=",
        kind: "where aggregate reports go",
        definition:
          "The addresses that receive aggregate reports, as mailto: URIs, separated by commas. Without rua nobody is told who sends as the domain, so moving to enforcement is guesswork.",
        example: "rua=mailto:dmarc@pellowyn-dental.example",
        tool: "/tools/dmarc-generator",
        see: ["aggregate-report", "external-destination"],
      },
      {
        id: "aggregate-report",
        name: "Aggregate report",
        kind: "the daily summary, in XML",
        definition:
          "A file a receiver such as Google, Microsoft or Yahoo sends, usually once a day, listing every server that sent mail as the domain, how many messages, and whether SPF, DKIM and DMARC passed. It holds no message content.",
        see: ["rua", "report-organisation"],
      },
      {
        id: "ruf",
        name: "ruf= and failure reports",
        kind: "per-message samples",
        definition:
          "ruf asks for a report about each failing message, which can include its headers and so personal data. Few receivers send them. fo= sets when one is sent: 0 when every check fails (the default), 1 when any fails, d for DKIM, s for SPF.",
        example: "ruf=mailto:dmarc-failures@pellowyn-dental.example; fo=1",
        see: ["aggregate-report"],
      },
      {
        id: "report-organisation",
        name: "Report organisation",
        kind: "who sent the report",
        definition:
          "The mailbox provider or company that produced a report, named in it, such as google.com or Outlook.com. One organisation's report covers only the mail it received.",
        see: ["aggregate-report"],
      },
      {
        id: "external-destination",
        name: "External report authorisation",
        kind: "reports to another domain",
        definition:
          "When rua points at another domain, receivers send reports there only if that domain agrees, with a TXT record of v=DMARC1 at <your domain>._report._dmarc.<their domain>. Monitoring services publish it for every customer.",
        example: "pellowyn-dental.example._report._dmarc.reports.service.example  TXT  \"v=DMARC1\"",
        see: ["rua"],
      },
    ],
  },
  {
    id: "domains",
    name: "Domains and senders",
    kind: "who mail claims to come from",
    terms: [
      {
        id: "organisational-domain",
        name: "Organisational domain",
        kind: "the registered domain",
        definition:
          "The domain someone registered, such as pellowyn-dental.example for mail.pellowyn-dental.example. Relaxed alignment and subdomain policy are worked out from it; RFC 9989 finds it by looking for DMARC records up the name's labels.",
        see: ["relaxed-alignment", "subdomain-policy", "psd"],
      },
      {
        id: "psd",
        name: "psd=",
        kind: "public suffix domain",
        definition:
          "Marks a domain as a public suffix, like a country code domain whose operator publishes DMARC for names under it. psd=y is for those operators only; on an ordinary domain it changes which domain counts as organisational.",
        see: ["organisational-domain"],
      },
      {
        id: "spoofing",
        name: "Spoofing",
        kind: "sending as someone else",
        definition:
          "Mail that puts a domain in the From line without the owner's permission, the basis of most phishing. DMARC at enforcement stops exact-domain spoofing at receivers that check it; it does not stop look-alike domains.",
        see: ["enforcement", "header-from"],
      },
      {
        id: "forwarding",
        name: "Forwarding",
        kind: "why some real mail fails",
        definition:
          "When a message is forwarded or sent through a mailing list, SPF usually fails because the forwarder's server is not in the record, and DKIM fails if the message was changed. DKIM that survives, or ARC, keeps it passing.",
        see: ["arc", "dkim"],
      },
      {
        id: "sending-service",
        name: "Sending service",
        kind: "a sender on the domain",
        definition:
          "Any system that sends mail as the domain: the mailbox host (Microsoft 365, Google Workspace), marketing tools, ticketing, invoicing, a website's contact form. Each needs SPF or DKIM set up for the domain before enforcement.",
        see: ["spf", "dkim"],
      },
    ],
  },
  {
    id: "logo",
    name: "The logo",
    kind: "BIMI's requirements",
    terms: [
      {
        id: "vmc",
        name: "VMC and CMC",
        kind: "logo certificates",
        definition:
          "A Verified Mark Certificate proves a logo is a registered trademark of the domain's owner; a Common Mark Certificate covers a logo without a trademark that has been in use. Gmail and Apple Mail show a BIMI logo only with one of them, named in the a= tag.",
        tool: "/tools/bimi",
        see: ["bimi"],
      },
      {
        id: "svg-tiny-ps",
        name: "SVG Tiny PS",
        kind: "the logo file format",
        definition:
          "The restricted SVG profile BIMI logos must use: baseProfile=\"tiny-ps\", version 1.2, a title, no scripts, animation or links to outside files, and a square image, served over HTTPS.",
        tool: "/tools/bimi",
        see: ["bimi"],
      },
    ],
  },
];

export const GLOSSARY_TERMS: GlossaryTerm[] = GLOSSARY.flatMap((g) => g.terms);

export function glossaryTerm(id: string): GlossaryTerm | undefined {
  return GLOSSARY_TERMS.find((t) => t.id === id);
}

export const GLOSSARY_PAGE = {
  path: "/glossary",
  title: "DMARC, SPF and DKIM glossary",
  description:
    "Every email authentication term an MSP meets, in plain words: DMARC, SPF, DKIM, alignment, the policy tags, aggregate reports, BIMI and more, each with an example and a free tool to check it.",
};

/** The glossary as Markdown, for llms-full.txt. */
export function glossaryMarkdown(): string {
  const lines: string[] = [];
  for (const group of GLOSSARY) {
    lines.push(`## ${group.name}`, "");
    for (const term of group.terms) {
      lines.push(`**${term.name}** (${term.kind}). ${term.definition}`);
      if (term.example) lines.push("", "```text", term.example, "```");
      lines.push("");
    }
  }
  return lines.join("\n").trim() + "\n";
}
