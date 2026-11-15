/**
 * msp-page.ts — /dmarc-for-msps: what an MSP needs from DMARC software, and
 * how this product meets each need, for the searches an MSP makes ("DMARC for
 * MSPs", "white label DMARC reports", "DMARC monitoring for clients").
 *
 * Every claim is something the product does today and the linked page shows;
 * no comparison with another product and no figure that is not ours. The
 * questions below are also the page's FAQPage, so they are written to be read
 * on their own, the way a search result or an answer engine quotes them.
 */

export const MSP_PAGE = {
  path: "/dmarc-for-msps",
  title: "DMARC monitoring for MSPs and IT agencies",
  description:
    "DMARC software built for MSPs: every client's domains in one place, white label reports and a client portal in your brand, PSA tickets, hosted DMARC and SPF, and a free plan to start.",
} as const;

export interface MspNeed {
  id: string;
  name: string;
  /** How the product meets it, in a sentence or two. */
  text: string;
  /** The page that shows it. */
  href: string;
  linkLabel: string;
}

export const MSP_NEEDS: MspNeed[] = [
  {
    id: "every-client",
    name: "Every client in one place",
    text: "Clients are a list of their own, each with its domains, its posture and its alerts. The portfolio puts the domain that needs you first, across every client.",
    href: "/guide",
    linkLabel: "Setup guide",
  },
  {
    id: "white-label",
    name: "Reports in your brand, not ours",
    text: "A client portal, share links, monthly reports and compliance packs carry your name, logo and colours. On Admiralty they are on your own web address and their email comes from your own domain.",
    href: "/pricing",
    linkLabel: "Plans",
  },
  {
    id: "to-reject",
    name: "A safe route to p=reject",
    text: "Every service sending as a client's domain is named, from the reports receivers send. Each domain says when it is ready for p=quarantine and then p=reject, and a domain that has never reported is never called passing.",
    href: "/faq",
    linkLabel: "FAQ",
  },
  {
    id: "records",
    name: "Records it can publish for you",
    text: "Hosted DMARC changes a client's policy with no DNS edit, managed SPF keeps a record under the limit of 10 lookups, and hosted BIMI and MTA-STS are served for you. Each change is recorded.",
    href: "/guide",
    linkLabel: "Setup guide",
  },
  {
    id: "your-tools",
    name: "Fits the tools you already run",
    text: "Alerts open tickets in HaloPSA (ConnectWise and Autotask in early access), post to Slack and Microsoft Teams, and go out as signed webhooks. A REST API covers clients, domains, reports and alerts.",
    href: "/docs/api",
    linkLabel: "API reference",
  },
  {
    id: "evidence",
    name: "Evidence you can hand over",
    text: "Compliance packs and monthly reports carry a published SHA-256 fingerprint that anyone can check on the verify page, so a client's auditor can confirm the document is the one issued.",
    href: "/verify",
    linkLabel: "Verify a pack",
  },
  {
    id: "start-free",
    name: "Free to start, prices in public",
    text: "The free plan watches one client's two domains with no card. Every plan's price is on the pricing page in US dollars and Indian rupees, and data stays in the EU, in Frankfurt.",
    href: "/pricing",
    linkLabel: "Pricing",
  },
];

export interface MspQuestion {
  id: string;
  question: string;
  answer: string;
}

export const MSP_QUESTIONS: MspQuestion[] = [
  {
    id: "what-is-dmarc-monitoring-for-msps",
    question: "What is DMARC monitoring for MSPs?",
    answer:
      "DMARC monitoring reads the aggregate reports that receiving mail servers send about a domain and shows which services send mail as it and whether that mail passes SPF, DKIM and DMARC. For an MSP it means doing that for every client's domains at once: one list of clients, each domain's posture, alerts when something changes, and reports to send each client.",
  },
  {
    id: "white-label-dmarc-reports",
    question: "Can I white-label DMARC reports for my clients?",
    answer:
      "Yes. From the Harbor plan, the client portal, share links, monthly reports and compliance packs show your agency's name, logo, colours and support contact instead of ours. On Admiralty the client pages can be on your own web address, and client email can come from your own sending domain.",
  },
  {
    id: "move-to-p-reject",
    question: "How do I move a client's domain to p=reject without breaking its mail?",
    answer:
      "Start at p=none with a report address, and wait for reports to name every service that sends as the domain. Fix SPF and DKIM for each legitimate sender until its mail aligns, then move to p=quarantine and finally p=reject. DMARC Harbor names the senders from the reports and says when each domain is ready for the next step.",
  },
  {
    id: "gmail-yahoo-microsoft-requirements",
    question: "Do my clients need DMARC for Gmail, Yahoo and Microsoft?",
    answer:
      "Gmail, Yahoo and Microsoft require a DMARC record from bulk senders, and mail from domains without SPF, DKIM and DMARC is more likely to be filtered. Each domain's page in DMARC Harbor shows which of those sender requirements it meets and what is missing, on every plan.",
  },
  {
    id: "dmarc-psa-tickets",
    question: "Can DMARC alerts open tickets in my PSA?",
    answer:
      "Yes. Alerts can open tickets in HaloPSA, with ConnectWise PSA and Autotask in early access, and each client maps to its company in the PSA. Alerts can also post to Slack and Microsoft Teams or be sent as signed webhooks.",
  },
  {
    id: "dmarc-pricing-for-msps",
    question: "How much does DMARC monitoring cost for an MSP?",
    answer:
      "DMARC Harbor has a free plan for one client with two domains and no card. Paid plans are priced by the size of the client book (clients, active domains and team members), monthly or annual, and a per-domain plan suits a large book. Every price is on the pricing page in US dollars and Indian rupees.",
  },
  {
    id: "where-is-data-stored",
    question: "Where is the DMARC report data stored?",
    answer:
      "In the European Union, in Frankfurt, for every customer and every plan. The Sub-processors page names every service that handles data and where.",
  },
];
