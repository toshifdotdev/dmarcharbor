/**
 * tools.ts — the free lookup tools, once: their paths, names and the words
 * search results and the llms.txt index use. The pages, the footer, the
 * sitemap allowlist and llms.txt all read this list, so a tool added here is
 * added everywhere on the same edit.
 *
 * Titles and names use the words people search with ("DMARC checker", "SPF
 * checker"), and each tool carries the questions people ask about it. The
 * questions are shown on the page and published as a FAQPage with the same
 * words (components/harbor/tools/tool-frame.tsx). In an answer, `backticks`
 * mark literal DNS: the page sets it in mono, the structured data drops them.
 *
 * Every lookup runs through the public scanner (POST /api/scan): no account,
 * nothing stored about the domain. The generator runs in the browser alone.
 */

export interface ToolQuestion {
  /** The anchor on the page. */
  id: string;
  question: string;
  answer: string;
}

export interface FreeTool {
  slug: "dmarc" | "spf" | "dkim" | "bimi" | "dmarc-generator" | "report-reader" | "header-analyser";
  path: string;
  /** Bold name, as a station label. */
  name: string;
  /** The lighter kind beside it. */
  kind: string;
  /** The page title and its search description. */
  title: string;
  description: string;
  /** What the questions are about, for their heading: "Questions about …". */
  topic: string;
  faq: ToolQuestion[];
}

export const FREE_TOOLS: FreeTool[] = [
  {
    slug: "dmarc",
    path: "/tools/dmarc",
    name: "DMARC checker",
    kind: "a policy, read tag by tag",
    title: "DMARC checker: free DMARC record lookup",
    description:
      "Check any domain's DMARC record tag by tag: the policy, where reports go, alignment and testing, and what each makes receivers do. Free, no account.",
    topic: "DMARC records",
    faq: [
      {
        id: "how-to-check-dmarc",
        question: "How do I check a domain's DMARC record?",
        answer:
          "Type the domain above. The checker reads the TXT record at `_dmarc.<domain>` from public DNS and explains every tag, including the ones left out and the default that applies. By hand, `dig TXT _dmarc.example.com` or `nslookup -type=TXT _dmarc.example.com` returns the same record.",
      },
      {
        id: "good-dmarc-record",
        question: "What does a good DMARC record look like?",
        answer:
          "It starts with `v=DMARC1`, sets a policy and names an address for aggregate reports, for example `v=DMARC1; p=reject; rua=mailto:dmarc@example.com`. Start at `p=none` to collect reports, then move to quarantine and reject once the reports show every service that sends as the domain passing.",
      },
      {
        id: "no-dmarc-record",
        question: "Why does the checker find no DMARC record?",
        answer:
          "Either nothing is published at `_dmarc.<domain>`, the record does not start with `v=DMARC1`, or there are two records, which receivers treat as none. A record added a moment ago can take until the old answer's TTL expires to appear.",
      },
      {
        id: "dmarc-check-vs-reports",
        question: "Does a DMARC check show whether mail is passing?",
        answer:
          "No. DNS only says what the domain asks receivers to do. Which mail passed and which failed is in the aggregate reports receivers send to the rua address, which is what DMARC monitoring reads.",
      },
    ],
  },
  {
    slug: "spf",
    path: "/tools/spf",
    name: "SPF checker",
    kind: "every include, counted",
    title: "SPF checker and SPF lookup counter",
    description:
      "Check a domain's SPF record and count its DNS lookups the way receivers do, through every include, against the limit of 10. Free, no account.",
    topic: "SPF records",
    faq: [
      {
        id: "how-to-check-spf",
        question: "How do I check an SPF record?",
        answer:
          "Type the domain above. The checker reads the TXT record that starts with `v=spf1`, follows every include and redirect the way a receiver does, and counts the DNS lookups each one costs.",
      },
      {
        id: "spf-lookup-limit",
        question: "What is the SPF 10 lookup limit?",
        answer:
          "A receiver stops after 10 DNS lookups while checking SPF and returns a permanent error, so SPF fails for every message. `include`, `a`, `mx`, `ptr`, `exists` and `redirect` each cost one, counted through every nested include; `ip4`, `ip6` and `all` cost nothing.",
      },
      {
        id: "fix-too-many-lookups",
        question: "How do I fix too many SPF lookups?",
        answer:
          "Remove includes for services the domain no longer uses, replace `a` and `mx` with `ip4` or `ip6` where the addresses are stable, and move a bulk sender to a subdomain with its own SPF record. Flattening includes into addresses works until a provider changes its addresses, so it needs watching.",
      },
      {
        id: "two-spf-records",
        question: "Can a domain have two SPF records?",
        answer:
          "No. Two TXT records starting with `v=spf1` give a permanent error and SPF fails. Merge them into one record with every service's include.",
      },
    ],
  },
  {
    slug: "dkim",
    path: "/tools/dkim",
    name: "DKIM checker",
    kind: "a selector's public key",
    title: "DKIM checker: DKIM record lookup",
    description:
      "Check a DKIM selector's key, or find the selectors a domain's mail services use, with key type, size and revoked keys. Free, no account.",
    topic: "DKIM records",
    faq: [
      {
        id: "how-to-check-dkim",
        question: "How do I check a DKIM record?",
        answer:
          "A DKIM key is published at `<selector>._domainkey.<domain>`, and DNS cannot list a domain's selectors. Find the selector in the `s=` tag of a message's DKIM-Signature header and type it above, or leave it empty and the checker tries the selectors common mail services use.",
      },
      {
        id: "dkim-key-size",
        question: "What size should a DKIM key be?",
        answer:
          "2048-bit RSA. Receivers must accept keys from 1024 bits and must refuse anything shorter (RFC 8301). Ed25519 keys (RFC 8463) are verified by few receivers, so publish one beside an RSA key, never instead of it.",
      },
      {
        id: "revoked-dkim-key",
        question: "What does a revoked DKIM key mean?",
        answer:
          "The record has an empty `p=` tag, so every signature made with that selector fails. It is how a key is retired: the service signs with a new selector and the old one is emptied.",
      },
      {
        id: "no-dkim-record",
        question: "Why does the checker find no DKIM key?",
        answer:
          "The selector is wrong, the CNAME records the mail service asked for were never published, or DKIM was never turned on in that service's console. The domain's setup guide for the service says which records it needs.",
      },
    ],
  },
  {
    slug: "bimi",
    path: "/tools/bimi",
    name: "BIMI checker",
    kind: "the logo record and its checks",
    title: "BIMI checker: BIMI record and logo lookup",
    description:
      "Check a BIMI record, its logo against the SVG Tiny PS rules, its certificate, and whether the DMARC policy lets the logo show. Free, no account.",
    topic: "BIMI",
    faq: [
      {
        id: "bimi-requirements",
        question: "What does a domain need for BIMI?",
        answer:
          "DMARC at quarantine or reject for all of its mail, a TXT record at `default._bimi.<domain>` pointing at the logo, and the logo as an SVG Tiny PS file served over HTTPS. Gmail and Apple Mail also need a Verified Mark Certificate or a Common Mark Certificate, named in the `a=` tag.",
      },
      {
        id: "bimi-logo-not-showing",
        question: "Why is my BIMI logo not showing?",
        answer:
          "Usually one of: DMARC is at `p=none`, the logo is not SVG Tiny PS, there is no certificate for a provider that needs one, or the message itself failed DMARC. Each mailbox provider also decides on its own whether to show a logo, so a valid setup can still show none at some of them.",
      },
      {
        id: "bimi-certificate",
        question: "Is a certificate required for BIMI?",
        answer:
          "Gmail and Apple Mail show a logo only with a VMC or CMC. Yahoo shows logos without one for senders it judges to have enough volume and a good reputation.",
      },
    ],
  },
  {
    slug: "dmarc-generator",
    path: "/tools/dmarc-generator",
    name: "DMARC generator",
    kind: "a record to publish",
    title: "DMARC generator: create a DMARC record",
    description:
      "Create a DMARC record: choose the policy, report addresses, alignment and testing, then copy the TXT record with what each tag does. Free.",
    topic: "creating a DMARC record",
    faq: [
      {
        id: "how-to-create-dmarc",
        question: "How do I create a DMARC record?",
        answer:
          "Choose the policy and the report address above, copy the record, and add it at the domain's DNS host as a TXT record named `_dmarc`. Most DNS hosts add the domain to the name themselves; if yours does not, use `_dmarc.<domain>`.",
      },
      {
        id: "which-dmarc-policy",
        question: "Which DMARC policy should I start with?",
        answer:
          "`p=none` with a rua address, so receivers report without changing delivery. Read the reports, fix each service that sends as the domain until it passes, then move to `p=quarantine` and then `p=reject`.",
      },
      {
        id: "one-dmarc-record",
        question: "Can I publish more than one DMARC record?",
        answer:
          "No. With two records at `_dmarc.<domain>` receivers apply none of them. Edit the existing record instead of adding a second.",
      },
      {
        id: "reports-to-another-domain",
        question: "Can reports go to an address at another domain?",
        answer:
          "Yes, if that domain agrees: it publishes `<your-domain>._report._dmarc.<its-domain>` as a TXT record containing `v=DMARC1`. Without it, receivers send no reports to that address. Report services publish this for their customers.",
      },
    ],
  },
  {
    slug: "report-reader",
    path: "/tools/dmarc-report-reader",
    name: "Report reader",
    kind: "an aggregate report, read",
    title: "DMARC report analyser: read XML reports",
    description:
      "Read a DMARC aggregate report (XML, .zip or .xml.gz): every source, its SPF and DKIM results and what the receiver did. Never uploaded. Free.",
    topic: "DMARC reports",
    faq: [
      {
        id: "what-is-aggregate-report",
        question: "What is a DMARC aggregate report?",
        answer:
          "An XML file a receiver such as Google or Microsoft sends to the rua address, usually once a day and compressed as .zip or .gz. Each row is one sending IP address with its message count, its SPF and DKIM results, and what the receiver did with the mail.",
      },
      {
        id: "how-to-read-report",
        question: "How do I read a DMARC report?",
        answer:
          "Drop the file above as it arrived, zipped or not. Each source is shown with the service it belongs to where known, how many messages it sent, and whether they passed SPF and DKIM aligned with the From domain.",
      },
      {
        id: "report-uploaded",
        question: "Is the report uploaded anywhere?",
        answer:
          "No. The file is opened and read in your browser, and nothing about it is sent to a server.",
      },
      {
        id: "too-many-reports",
        question: "Why do I get so many reports?",
        answer:
          "Each receiver sends its own report for each domain, usually every day, so a domain with mail at several providers gets several a day, and an agency gets that for every client. Reading them by hand stops working quickly, which is why monitoring services read them.",
      },
    ],
  },
  {
    slug: "header-analyser",
    path: "/tools/email-header-analyser",
    name: "Header analyser",
    kind: "one message, checked",
    title: "Email header analyser: SPF, DKIM, DMARC",
    description:
      "Paste a message's headers to see if SPF, DKIM and DMARC passed and aligned, and every server it passed through. Read in your browser. Free.",
    topic: "email headers",
    faq: [
      {
        id: "find-headers",
        question: "How do I find a message's headers?",
        answer:
          "In Gmail, open the message, then More and Show original. In Outlook on the web, open the message, then More actions, View and View message details. In Outlook for Windows, open the message in its own window, then File and Properties. In Apple Mail, View, Message and All Headers.",
      },
      {
        id: "authentication-results",
        question: "What does the Authentication-Results header show?",
        answer:
          "The receiving server's verdict for SPF, DKIM and DMARC, with the domain each check used. DMARC passes when SPF or DKIM passed for a domain that matches the From address's domain.",
      },
      {
        id: "spf-pass-dmarc-fail",
        question: "Why does DMARC fail when SPF or DKIM passes?",
        answer:
          "Because the check passed for another domain. SPF checks the envelope sender, and a service often uses its own domain there; DKIM checks the `d=` domain, which may be the service's. Neither counts for DMARC unless it matches the From domain.",
      },
      {
        id: "headers-uploaded",
        question: "Are the headers uploaded anywhere?",
        answer: "No. They are read in your browser, and nothing is sent to a server.",
      },
    ],
  },
];

/** The index page's title and search description. */
export const TOOLS_INDEX = {
  title: "Free DMARC, SPF, DKIM and BIMI checkers",
  description:
    "Free DMARC, SPF, DKIM and BIMI checkers, a DMARC record generator, a report reader and an email header analyser. No account needed.",
};

/** The index page, then each tool. */
export const TOOL_PATHS: string[] = ["/tools", ...FREE_TOOLS.map((t) => t.path)];

export function toolBySlug(slug: FreeTool["slug"]): FreeTool {
  const tool = FREE_TOOLS.find((t) => t.slug === slug);
  if (!tool) throw new Error(`No free tool ${slug}`);
  return tool;
}

/** An answer without its literal-DNS marks, for structured data and plain text. */
export function plainAnswer(answer: string): string {
  return answer.replace(/`([^`]*)`/g, "$1");
}
