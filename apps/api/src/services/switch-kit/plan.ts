import type { DnsReader } from '../../scanner/types.js';
import { isDmarcPolicyRecord } from '../../scanner/dmarc-policy.js';
import { parseDmarcTags } from '../../scanner/dmarc-tags.js';
import { buildDmarcRecord } from '../onboarding.service.js';
import { isOurAddress, normaliseReportUri } from '../report-address.service.js';
import { buildDualRecord, readRuaUris, type SwitchWarning } from './record-rewrite.js';
import { detectVendor } from './vendors.js';

export type SwitchLookup = 'found' | 'no_record' | 'multiple_records' | 'invalid' | 'lookup_failed';
export type ExternalAuthorization = 'authorized' | 'missing' | 'error';

export interface SwitchIncumbent {
  vendor: string;
  label: string;
  host: string;
  /** The raw rua URI, as it appeared in the record. */
  uri: string;
}

export interface SwitchPlan {
  domain: string;
  host: string;
  lookup: SwitchLookup;
  /** The record to publish, or null when there is nothing safe to publish. */
  record: { host: string; type: 'TXT'; value: string } | null;
  /** The record as read, for display and for the audit-free row. */
  currentRecord: string | null;
  /** Where a CNAME sends the name, when one is published. */
  cname: string | null;
  alreadyReportingToUs: boolean;
  incumbents: SwitchIncumbent[];
  /** Raw rua URIs classified as the incumbent's. */
  incumbentAggregateTargets: string[];
  /** Raw ruf URIs pointing at the same incumbent hosts. */
  incumbentForensicTargets: string[];
  primaryIncumbent: { vendor: string; label: string } | null;
  externalAuthorization: ExternalAuthorization;
  warnings: SwitchWarning[];
  message: string | null;
}

function hostOf(uri: string): string | null {
  if (/^https:\/\//i.test(uri.trim())) {
    try {
      return new URL(uri.trim()).hostname.toLowerCase() || null;
    } catch {
      return null;
    }
  }

  const address = normaliseReportUri(uri);
  if (!address) {
    return null;
  }
  const at = address.lastIndexOf('@');
  return at > 0 ? address.slice(at + 1) : null;
}

function pickPrimary(incumbents: SwitchIncumbent[]): { vendor: string; label: string } | null {
  const known = incumbents.find((entry) => entry.vendor !== 'self' && entry.vendor !== 'other');
  if (known) {
    return { vendor: known.vendor, label: known.label };
  }
  const other = incumbents.find((entry) => entry.vendor === 'other');
  if (other) {
    return { vendor: other.vendor, label: other.label };
  }
  const self = incumbents.find((entry) => entry.vendor === 'self');
  return self ? { vendor: self.vendor, label: self.label } : null;
}

/**
 * Reads one domain's live DNS and works out how to add our address alongside
 * the incumbent's.
 *
 * Nothing here writes. A plan is an observation plus a record, which is what
 * lets the import show every row before anyone changes DNS.
 */
export async function planDomainSwitch(input: {
  domainName: string;
  ourAddress: string;
  dns: DnsReader;
}): Promise<SwitchPlan> {
  const { domainName, ourAddress, dns } = input;
  const host = `_dmarc.${domainName}`;
  const ourDomain = ourAddress.slice(ourAddress.lastIndexOf('@') + 1);
  const authorizationHost = `${domainName}._report._dmarc.${ourDomain}`;

  const [txtLookup, cnameLookup, authorizationLookup] = await Promise.all([
    dns.resolveTxt(host),
    dns.resolveCname ? dns.resolveCname(host) : Promise.resolve(null),
    dns.resolveTxt(authorizationHost),
  ]);

  const cname =
    cnameLookup && cnameLookup.status === 'found' && cnameLookup.value && cnameLookup.value.length > 0
      ? cnameLookup.value[0]!
      : null;

  const warnings: SwitchWarning[] = [];
  if (cname) {
    warnings.push({
      code: 'cname',
      message: `A CNAME points ${host} at ${cname}. A CNAME and a TXT record cannot coexist at one name: replace the CNAME with this TXT record, or edit the record at ${cname}.`,
    });
  }

  const externalAuthorization: ExternalAuthorization =
    authorizationLookup.status === 'error'
      ? 'error'
      : authorizationLookup.status === 'found' &&
          (authorizationLookup.value ?? []).some((chunks) =>
            chunks.join('').trim().toLowerCase().startsWith('v=dmarc1'),
          )
        ? 'authorized'
        : 'missing';

  if (externalAuthorization === 'missing') {
    warnings.push({
      code: 'authorization_missing',
      message: `This deployment has not authorised ${domainName} to send reports to ${ourDomain}. An operator must publish a wildcard TXT record at *._report._dmarc.${ourDomain} with the value v=DMARC1.`,
    });
  }

  const emptyPlan = {
    domain: domainName,
    host,
    cname,
    alreadyReportingToUs: false,
    incumbents: [] as SwitchIncumbent[],
    incumbentAggregateTargets: [] as string[],
    incumbentForensicTargets: [] as string[],
    primaryIncumbent: null,
    externalAuthorization,
    warnings,
  };

  if (txtLookup.status === 'error') {
    return {
      ...emptyPlan,
      lookup: 'lookup_failed',
      record: null,
      currentRecord: null,
      message: 'The DNS lookup failed. Try again in a few minutes.',
    };
  }

  const strings = (txtLookup.value ?? [])
    .map((chunks) => chunks.join('').trim())
    .filter(Boolean);
  const dmarcRecords = strings.filter((record) => isDmarcPolicyRecord(record));

  if (strings.length === 0) {
    return {
      ...emptyPlan,
      lookup: 'no_record',
      record: {
        host,
        type: 'TXT',
        value: buildDmarcRecord(domainName, 'none', false, { aggregateAddress: ourAddress }).value,
      },
      currentRecord: null,
      message: null,
    };
  }

  if (dmarcRecords.length > 1) {
    return {
      ...emptyPlan,
      lookup: 'multiple_records',
      record: null,
      currentRecord: null,
      message: 'More than one DMARC record is published, so receivers ignore all of them.',
    };
  }

  // Other TXT strings at _dmarc are ignored by receivers (RFC 7489 section
  // 6.6.3 discards records that do not start with v=DMARC1), so one policy
  // record beside them is a working record, not an invalid one.
  if (dmarcRecords.length === 0) {
    return {
      ...emptyPlan,
      lookup: 'invalid',
      record: null,
      currentRecord: null,
      message: 'The TXT record at this name is not a valid DMARC record.',
    };
  }

  const currentRecord = dmarcRecords[0]!;
  const tags = parseDmarcTags(currentRecord);
  const ruaUris = readRuaUris(tags.rua ?? '');
  const incumbents: SwitchIncumbent[] = [];
  let alreadyReportingToUs = false;

  for (const uri of ruaUris) {
    if (isOurAddress(uri)) {
      alreadyReportingToUs = true;
      continue;
    }

    const incumbentHost = hostOf(uri);
    if (!incumbentHost) {
      continue;
    }

    const vendor = detectVendor(incumbentHost, domainName);
    incumbents.push({ vendor: vendor.id, label: vendor.label, host: incumbentHost, uri });
  }

  const incumbentHosts = new Set(incumbents.map((entry) => entry.host));
  const incumbentForensicTargets = readRuaUris(tags.ruf ?? '').filter((uri) => {
    const forensicHost = hostOf(uri);
    return forensicHost !== null && incumbentHosts.has(forensicHost);
  });

  const dual = buildDualRecord(currentRecord, ourAddress);

  return {
    domain: domainName,
    host,
    lookup: 'found',
    record: { host, type: 'TXT', value: dual.value },
    currentRecord,
    cname,
    alreadyReportingToUs,
    incumbents,
    incumbentAggregateTargets: incumbents.map((entry) => entry.uri),
    incumbentForensicTargets,
    primaryIncumbent: pickPrimary(incumbents),
    externalAuthorization,
    warnings: [...warnings, ...dual.warnings],
    message: null,
  };
}
