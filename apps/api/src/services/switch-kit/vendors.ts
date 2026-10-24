export interface ReportVendor {
  id: string;
  label: string;
  hostSuffixes: string[];
}

/**
 * The DMARC providers an agency most often wins a client from.
 *
 * A suffix matches a whole label boundary, never a substring: `notdmarcian.com`
 * must not be read as dmarcian, or the UI names the wrong incumbent and the
 * customer checks the wrong record. `postmarkapp.com` is deliberately not
 * `postmark.com`, because the DMARC digest product lives on the former.
 */
export const reportVendors: ReportVendor[] = [
  { id: 'dmarcian', label: 'dmarcian', hostSuffixes: ['dmarcian.com', 'dmarcian.eu'] },
  { id: 'easydmarc', label: 'EasyDMARC', hostSuffixes: ['easydmarc.us', 'easydmarc.com', 'easydmarc.eu'] },
  { id: 'powerdmarc', label: 'PowerDMARC', hostSuffixes: ['powerdmarc.com'] },
  { id: 'valimail', label: 'Valimail', hostSuffixes: ['vali.email', 'valimail.com'] },
  { id: 'redsift', label: 'Red Sift OnDMARC', hostSuffixes: ['ondmarc.com'] },
  { id: 'proofpoint', label: 'Proofpoint', hostSuffixes: ['proofpoint.com'] },
  { id: 'agari', label: 'Agari (Fortra)', hostSuffixes: ['agari.com'] },
  { id: 'mimecast', label: 'Mimecast DMARC Analyzer', hostSuffixes: ['dmarcanalyzer.com'] },
  { id: 'cloudflare', label: 'Cloudflare DMARC Management', hostSuffixes: ['cloudflare.net'] },
  { id: 'postmark', label: 'Postmark DMARC Digests', hostSuffixes: ['postmarkapp.com'] },
  { id: 'uriports', label: 'URIports', hostSuffixes: ['uriports.com'] },
  { id: 'dmarcly', label: 'DMARCLY', hostSuffixes: ['dmarcly.com'] },
  { id: 'sendmarc', label: 'Sendmarc', hostSuffixes: ['sendmarc.com'] },
  { id: 'reporturi', label: 'Report URI', hostSuffixes: ['report-uri.com'] },
];

function matchesSuffix(host: string, suffix: string): boolean {
  return host === suffix || host.endsWith(`.${suffix}`);
}

export interface DetectedVendor {
  id: string;
  label: string;
}

/**
 * The provider behind a report host.
 *
 * `self` is the customer's own mail infrastructure, recognised in both
 * directions so `mail.example.com` and `example.com` are not called a vendor.
 * Everything else is `other`, labelled with the host itself: naming an unknown
 * company is worse than showing the address the operator has to go and edit.
 */
export function detectVendor(host: string, domainName: string): DetectedVendor {
  const normalisedHost = host.trim().toLowerCase().replace(/\.$/, '');
  const normalisedDomain = domainName.trim().toLowerCase().replace(/\.$/, '');

  for (const vendor of reportVendors) {
    if (vendor.hostSuffixes.some((suffix) => matchesSuffix(normalisedHost, suffix))) {
      return { id: vendor.id, label: vendor.label };
    }
  }

  if (
    normalisedHost === normalisedDomain ||
    normalisedHost.endsWith(`.${normalisedDomain}`) ||
    normalisedDomain.endsWith(`.${normalisedHost}`)
  ) {
    return { id: 'self', label: 'Your own mailbox' };
  }

  return { id: 'other', label: normalisedHost };
}
