/**
 * switch-guide.ts — /switch-dmarc-provider: moving a client's domains from
 * another DMARC service without losing a day of reports or changing their
 * policy, for the searches an MSP makes when it takes on a client that already
 * has one ("switch DMARC provider", "migrate from dmarcian", "move DMARC
 * reporting").
 *
 * Every step is what the switch kit does today (apps/api/src/services/
 * switch-kit/*, components/harbor/switch-kit.tsx and domain-switch.tsx): the
 * screen names, the records it writes and the readiness thresholds are the
 * code's own (overlap.ts cutoverThresholds). The providers listed are the ones
 * vendors.ts recognises by name. The questions are also the page's FAQPage.
 */
export const SWITCH_PAGE = {
  path: "/switch-dmarc-provider",
  title: "Switch DMARC provider without losing reports",
  description:
    "Move a client's domains from dmarcian, EasyDMARC, Valimail, PowerDMARC or any other DMARC service: report to both while you check, then cut over. The policy never changes and no day of reports is lost.",
} as const;

export interface SwitchStep {
  id: string;
  name: string;
  text: string;
}

/** The switch, in order, as the product runs it. */
export const SWITCH_STEPS: SwitchStep[] = [
  {
    id: "open",
    name: "Open the client's switch kit",
    text: "Add the client if it is not here yet, then on Clients choose Switch provider on its row. Nothing in DNS changes from this screen.",
  },
  {
    id: "paste",
    name: "Paste the client's domains",
    text: "Up to 100 at a time, one per line. Choose Check domains: each one is added if it is new, its live DMARC record is read and the service it reports to now is named. A subdomain with its own DMARC record is pasted as a domain of its own.",
  },
  {
    id: "dual",
    name: "Publish the dual record",
    text: "The kit writes the domain's own record back with our report address added first in rua=. Every other tag stays exactly as published: p=, sp=, adkim, aspf, ruf and fo. Enforcement does not change, and the old service keeps receiving its reports. Publish it at the client's DNS host, or, on Fairway and above, in one step through a Cloudflare connection. For a new domain, publishing it usually also proves you manage it; the screen says when.",
  },
  {
    id: "check",
    name: "Check DNS",
    text: "Choose Check all now on the switch kit, or Check DNS now on the domain's page. When DNS shows both addresses the domain moves to Dual reporting. Scheduled scans check it too.",
  },
  {
    id: "wait",
    name: "Let both services receive reports",
    text: "The domain's page lists every receiver that has reported since dual reporting began, how many days it sent and its share of the mail. It says Ready to cut over after 14 days of dual reporting, reports on at least 10 of the last 14 days, the receivers carrying 90% of the mail silent for no more than 3 days, and at least 100 messages. The advice never blocks you: you can cut over sooner.",
  },
  {
    id: "cutover",
    name: "Publish the cutover record",
    text: "From the domain's page. It removes the old service's report addresses, aggregate and forensic, and changes nothing else. Check DNS again and the domain reads Cut over. If the old address reappears later, the domain's page says so.",
  },
  {
    id: "cancel",
    name: "Then end the old subscription",
    text: "Once every domain of the client is cut over. Export the history you want to keep from the old service first: reports it received stay with it.",
  },
];

export interface SwitchQuestion {
  id: string;
  question: string;
  answer: string;
}

/** The services the switch kit names by their report address. */
export const RECOGNISED_SERVICES = [
  "dmarcian",
  "EasyDMARC",
  "PowerDMARC",
  "Valimail",
  "Red Sift OnDMARC",
  "Proofpoint",
  "Agari (Fortra)",
  "Mimecast DMARC Analyzer",
  "Cloudflare DMARC Management",
  "Postmark DMARC Digests",
  "URIports",
  "DMARCLY",
  "Sendmarc",
  "Report URI",
];

export const SWITCH_QUESTIONS: SwitchQuestion[] = [
  {
    id: "policy",
    question: "Does switching DMARC provider change the domain's policy?",
    answer:
      "No. The dual record and the cutover record change only the report addresses in rua= and ruf=. The policy, the subdomain policy and the alignment settings stay exactly as the domain published them, so no mail is treated differently on any day of the switch.",
  },
  {
    id: "reports",
    question: "Will any reports be lost during the switch?",
    answer:
      "No. While the dual record is published, receivers send each report to both services, so the old service keeps its full picture until you cut over and ours starts the day dual reporting begins. Reports the old service received before then stay with it; export them before you end that subscription if you want to keep them.",
  },
  {
    id: "how-long",
    question: "How long does a switch take?",
    answer:
      "Recommended: 14 days of reporting to both services, so every receiver that sends for the domain has been seen at least once. Receivers report only on days they saw the domain's mail, so a quiet domain takes longer to look complete. The readiness advice is a guide, not a lock: you can publish the cutover record whenever you choose.",
  },
  {
    id: "which-services",
    question: "Which DMARC services can I switch from?",
    answer: `Any service that receives reports by email or HTTPS. These are named by their report address: ${RECOGNISED_SERVICES.join(", ")}. Any other service is shown by its address, and a client's own mailbox is recognised as theirs.`,
  },
  {
    id: "cname",
    question: "The old service hosts the DMARC record through a CNAME. What then?",
    answer:
      "A CNAME and a TXT record cannot both sit at _dmarc. The switch kit reads the record the CNAME points at, writes the dual record from it and warns you. Remove the CNAME and publish the TXT record in its place, or edit the record at the old service if it lets you add a report address.",
  },
  {
    id: "third-address",
    question: "The record already sends reports to two places. Is a third a problem?",
    answer:
      "Some receivers serve only the first two report addresses in rua=, which is why ours is put first. The switch kit warns when a record would carry three or more, and names the addresses that may stop receiving.",
  },
  {
    id: "tls",
    question: "Does the switch move TLS reports or forensic reports?",
    answer:
      "Forensic addresses that belong to the old service stay during dual reporting and are removed at cutover; turn on forensic collection here if you want them. TLS reports are published at _smtp._tls, which the switch kit does not change: if that record points at the old service, update it yourself.",
  },
  {
    id: "plan",
    question: "Which plan includes the switch kit?",
    answer:
      "Every plan, the free one included. The domains you switch count toward the plan's active domains like any other, and the kit says which ones are over the limit instead of adding them.",
  },
  {
    id: "stop",
    question: "Can I stop a switch?",
    answer:
      "Yes. Stop switch on the domain's page removes the switch and leaves the domain, its reports and its DNS exactly as they are. You can start again later.",
  },
];
