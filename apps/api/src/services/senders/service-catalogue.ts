/**
 * The sending-service catalogue.
 *
 * Every entry is a claim that a hostname, PTR suffix or ASN belongs to a
 * service, so each signal has to be supportable from the vendor's own
 * documentation. A vendor whose documentation does not publish a signal is
 * listed with the signals it does publish, not with a guess. `source` is kept
 * beside the entry so support can check the reasoning later; it is never shown
 * in the interface.
 *
 * Matching is on a whole label boundary (`host === suffix || host ends with
 * '.suffix'`), case-insensitive, with a trailing dot ignored. A substring test
 * would make notsendgrid.net look like SendGrid.
 */

export const catalogueVersion = '2026-10';

export type ServiceCategory =
  | 'mailbox'
  | 'marketing'
  | 'transactional'
  | 'support'
  | 'crm'
  | 'security'
  | 'other';

export interface CatalogueEntry {
  id: string;
  name: string;
  category: ServiceCategory;
  /** Domains that appear as the authenticated DKIM d= value. */
  dkimDomains: string[];
  /** Domains that appear as the SPF-authenticated envelope-from domain. */
  spfDomains: string[];
  /** Confirmed PTR suffixes owned by the service. */
  ptrSuffixes: string[];
  /** ASNs that are specific enough to name the service, when a second signal agrees. */
  asns: number[];
  source: string;
}

export const serviceCatalogue: readonly CatalogueEntry[] = [
  {
    id: 'google-workspace',
    name: 'Google Workspace',
    category: 'mailbox',
    dkimDomains: ['google.com'],
    spfDomains: ['_spf.google.com', 'google.com'],
    // Not googleusercontent.com: that is the reverse DNS of every Google Cloud
    // customer VM, so anyone renting one would be named Google Workspace.
    ptrSuffixes: ['google.com', '1e100.net'],
    asns: [15169],
    source: 'https://support.google.com/a/answer/174124',
  },
  {
    id: 'microsoft-365',
    name: 'Microsoft 365',
    category: 'mailbox',
    dkimDomains: ['onmicrosoft.com', 'microsoft.com'],
    spfDomains: ['spf.protection.outlook.com', 'outlook.com', 'microsoft.com'],
    ptrSuffixes: ['outlook.com', 'protection.outlook.com', 'microsoft.com'],
    asns: [8075],
    source: 'https://learn.microsoft.com/en-us/defender-office-365/email-authentication-dkim-configure',
  },
  {
    id: 'amazon-ses',
    name: 'Amazon SES',
    category: 'transactional',
    dkimDomains: ['amazonses.com'],
    spfDomains: ['amazonses.com'],
    ptrSuffixes: ['amazonses.com'],
    asns: [16509, 14618],
    source: 'https://docs.aws.amazon.com/ses/latest/dg/send-email-authentication-dkim.html',
  },
  {
    id: 'sendgrid',
    name: 'SendGrid',
    category: 'transactional',
    dkimDomains: ['sendgrid.net'],
    spfDomains: ['sendgrid.net'],
    ptrSuffixes: ['sendgrid.net'],
    asns: [11377],
    source: 'https://docs.sendgrid.com/ui/account-and-settings/how-to-set-up-domain-authentication',
  },
  {
    id: 'mailchimp',
    name: 'Mailchimp',
    category: 'marketing',
    dkimDomains: ['mailchimp.com', 'mandrillapp.com'],
    spfDomains: ['mailchimp.com', 'mandrillapp.com', 'mcsv.net'],
    ptrSuffixes: ['mailchimp.com', 'mandrillapp.com', 'mcsv.net'],
    asns: [],
    source: 'https://mailchimp.com/help/set-up-email-domain-authentication/',
  },
  {
    id: 'mailgun',
    name: 'Mailgun',
    category: 'transactional',
    dkimDomains: ['mailgun.org', 'mailgun.net'],
    spfDomains: ['mailgun.org', 'mailgun.net'],
    ptrSuffixes: ['mailgun.org', 'mailgun.net'],
    asns: [],
    source: 'https://documentation.mailgun.com/docs/mailgun/user-manual/sending-setup/',
  },
  {
    id: 'postmark',
    name: 'Postmark',
    category: 'transactional',
    dkimDomains: ['postmarkapp.com', 'mtasv.net'],
    spfDomains: ['postmarkapp.com', 'mtasv.net'],
    ptrSuffixes: ['postmarkapp.com', 'mtasv.net'],
    asns: [],
    source: 'https://postmarkapp.com/support/article/1046-how-do-i-set-up-dkim-for-postmark',
  },
  {
    id: 'sparkpost',
    name: 'SparkPost',
    category: 'transactional',
    dkimDomains: ['sparkpostmail.com', 'sparkpost.com'],
    spfDomains: ['sparkpostmail.com', 'sparkpost.com'],
    ptrSuffixes: ['sparkpostmail.com', 'sparkpost.com'],
    asns: [],
    source: 'https://support.sparkpost.com/docs/tech-resources/email-authentication',
  },
  {
    id: 'brevo',
    name: 'Brevo',
    category: 'marketing',
    dkimDomains: ['brevo.com', 'sendinblue.com'],
    spfDomains: ['brevo.com', 'sendinblue.com'],
    ptrSuffixes: ['brevo.com', 'sendinblue.com'],
    asns: [],
    source: 'https://help.brevo.com/hc/en-us/articles/204829090-How-to-configure-DMARC',
  },
  {
    id: 'mailjet',
    name: 'Mailjet',
    category: 'marketing',
    dkimDomains: ['mailjet.com', 'mailjet.net'],
    spfDomains: ['mailjet.com', 'mailjet.net'],
    ptrSuffixes: ['mailjet.com', 'mailjet.net'],
    asns: [],
    source: 'https://documentation.mailjet.com/hc/en-us/articles/360043224294',
  },
  {
    id: 'hubspot',
    name: 'HubSpot',
    category: 'crm',
    dkimDomains: ['hubspotemail.net', 'hubspot.com'],
    spfDomains: ['hubspotemail.net', 'hubspot.com'],
    ptrSuffixes: ['hubspotemail.net', 'hubspot.com'],
    asns: [],
    source: 'https://knowledge.hubspot.com/email/verify-your-email-sending-domain',
  },
  {
    id: 'salesforce-marketing-cloud',
    name: 'Salesforce Marketing Cloud',
    category: 'marketing',
    dkimDomains: ['exacttarget.com', 'salesforce.com'],
    spfDomains: ['exacttarget.com', 'salesforce.com'],
    ptrSuffixes: ['exacttarget.com', 'salesforce.com'],
    asns: [],
    source: 'https://help.salesforce.com/s/articleView?id=000382473&type=1',
  },
  {
    id: 'klaviyo',
    name: 'Klaviyo',
    category: 'marketing',
    dkimDomains: ['klaviyomail.com', 'klaviyo.com'],
    spfDomains: ['klaviyomail.com', 'klaviyo.com'],
    ptrSuffixes: ['klaviyomail.com', 'klaviyo.com'],
    asns: [],
    source: 'https://help.klaviyo.com/hc/en-us/articles/115001602811',
  },
  {
    id: 'constant-contact',
    name: 'Constant Contact',
    category: 'marketing',
    dkimDomains: ['constantcontact.com', 'ctctcdn.com'],
    spfDomains: ['constantcontact.com', 'ctctcdn.com'],
    ptrSuffixes: ['constantcontact.com', 'ctctcdn.com'],
    asns: [],
    source: 'https://knowledgebase.constantcontact.com/email-digital-marketing/articles/KnowledgeBase/5245-Email-Authentication',
  },
  {
    id: 'zendesk',
    name: 'Zendesk',
    category: 'support',
    dkimDomains: ['zendesk.com', 'zendeskmail.com'],
    spfDomains: ['zendesk.com', 'zendeskmail.com'],
    ptrSuffixes: ['zendesk.com', 'zendeskmail.com'],
    asns: [],
    source: 'https://support.zendesk.com/hc/en-us/articles/4408832572314',
  },
  {
    id: 'freshdesk',
    name: 'Freshdesk',
    category: 'support',
    dkimDomains: ['freshdesk.com', 'freshworks.com'],
    spfDomains: ['freshdesk.com', 'freshworks.com'],
    ptrSuffixes: ['freshdesk.com', 'freshworks.com'],
    asns: [],
    source: 'https://support.freshdesk.com/support/solutions/articles/5000011418',
  },
  {
    id: 'zoho-mail',
    name: 'Zoho Mail',
    category: 'mailbox',
    dkimDomains: ['zoho.com', 'zohomail.com', 'zoho.in'],
    spfDomains: ['zoho.com', 'zohomail.com', 'zoho.in'],
    ptrSuffixes: ['zoho.com', 'zohomail.com', 'zoho.in'],
    asns: [],
    source: 'https://www.zoho.com/mail/help/adminconsole/configure-dkim.html',
  },
  {
    id: 'atlassian',
    name: 'Atlassian',
    category: 'other',
    dkimDomains: ['atlassian.net', 'atlassian.com'],
    spfDomains: ['atlassian.net', 'atlassian.com'],
    ptrSuffixes: ['atlassian.net', 'atlassian.com'],
    asns: [],
    source: 'https://support.atlassian.com/provisioning-users/docs/configure-spf-and-dkim/',
  },
  {
    id: 'intercom',
    name: 'Intercom',
    category: 'support',
    dkimDomains: ['intercom.io', 'intercom.com'],
    spfDomains: ['intercom.io', 'intercom.com'],
    ptrSuffixes: ['intercom.io', 'intercom.com'],
    asns: [],
    source: 'https://www.intercom.com/help/en/articles/2129-set-up-spf-and-dkim',
  },
  {
    id: 'campaign-monitor',
    name: 'Campaign Monitor',
    category: 'marketing',
    dkimDomains: ['createsend.com', 'campaignmonitor.com'],
    spfDomains: ['createsend.com', 'campaignmonitor.com'],
    ptrSuffixes: ['createsend.com', 'campaignmonitor.com'],
    asns: [],
    source: 'https://help.campaignmonitor.com/email-authentication',
  },
  {
    id: 'customer-io',
    name: 'Customer.io',
    category: 'marketing',
    dkimDomains: ['customer.io', 'customeriomail.com'],
    spfDomains: ['customer.io', 'customeriomail.com'],
    ptrSuffixes: ['customer.io', 'customeriomail.com'],
    asns: [],
    source: 'https://docs.customer.io/accounts/domain-authentication/',
  },
  {
    id: 'resend',
    name: 'Resend',
    category: 'transactional',
    dkimDomains: ['resend.com'],
    spfDomains: ['resend.com'],
    ptrSuffixes: ['resend.com'],
    asns: [],
    source: 'https://resend.com/docs/dashboard/domains/introduction',
  },
  {
    id: 'proofpoint',
    name: 'Proofpoint',
    category: 'security',
    dkimDomains: ['pphosted.com', 'proofpoint.com'],
    spfDomains: ['pphosted.com', 'proofpoint.com'],
    ptrSuffixes: ['pphosted.com', 'proofpoint.com'],
    asns: [],
    source: 'https://help.proofpoint.com/',
  },
  {
    id: 'mimecast',
    name: 'Mimecast',
    category: 'security',
    dkimDomains: ['mimecast.com', 'mimecast.org'],
    spfDomains: ['mimecast.com', 'mimecast.org'],
    ptrSuffixes: ['mimecast.com', 'mimecast.org'],
    asns: [],
    source: 'https://help.mimecast.com/support/docs/Doc-11166',
  },
];

export const catalogueById = new Map(serviceCatalogue.map((entry) => [entry.id, entry]));

/** Whole-label, case-insensitive suffix matching with an optional trailing dot. */
export function domainMatchesSuffix(host: string, suffix: string): boolean {
  const cleanHost = host.trim().toLowerCase().replace(/\.+$/, '');
  const cleanSuffix = suffix.trim().toLowerCase().replace(/\.+$/, '');
  if (!cleanHost || !cleanSuffix) return false;
  return cleanHost === cleanSuffix || cleanHost.endsWith(`.${cleanSuffix}`);
}

export function entriesForDomain(domain: string, kind: 'dkim' | 'spf'): CatalogueEntry[] {
  const field = kind === 'dkim' ? 'dkimDomains' : 'spfDomains';
  return serviceCatalogue.filter((entry) =>
    entry[field].some((suffix) => domainMatchesSuffix(domain, suffix)),
  );
}

export function entriesForPtr(ptr: string): CatalogueEntry[] {
  return serviceCatalogue.filter((entry) =>
    entry.ptrSuffixes.some((suffix) => domainMatchesSuffix(ptr, suffix)),
  );
}

export function entriesForAsn(asn: number): CatalogueEntry[] {
  return serviceCatalogue.filter((entry) => entry.asns.includes(asn));
}
