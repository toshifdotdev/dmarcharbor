import { organizationalDomain } from '../services/alignment.service.js';
import type {
  BimiResult,
  DmarcResult,
  DnsReader,
  MtaStsResult,
  MxResult,
  ScanIssue,
  TlsRptResult,
} from '../models/scan.model.js';
import type { HttpsGetter } from './https-get.js';
import {
  bimiDmarcQualification,
  inspectBimiSvg,
  mxCoveredBy,
  parseBimiTxt,
  parseMtaStsPolicy,
  parseMtaStsTxt,
  parseTlsRptTxt,
  type BimiSvgChecks,
} from './transport-records.js';

const mtaStsPolicyBytes = 65_536;
const bimiLogoBytes = 32_768;

export interface TransportScan {
  mtaSts: MtaStsResult;
  tlsRpt: TlsRptResult;
  bimi: BimiResult;
  issues: ScanIssue[];
}

function issue(input: {
  code: string;
  title: string;
  message: string;
  recommendation: string;
}): ScanIssue {
  return { severity: 'warning', ...input };
}

function failedChecks(checks: BimiSvgChecks): string[] {
  const names: Array<[keyof BimiSvgChecks, string]> = [
    ['svgRoot', 'the first element is not svg'],
    ['tinyPsProfile', 'baseProfile="tiny-ps" is missing'],
    ['version12', 'version="1.2" is missing'],
    ['title', 'a non-empty title is missing'],
    ['noForbiddenElements', 'a forbidden element or event attribute is present'],
    ['noExternalReferences', 'an external href is present'],
    ['withinSizeLimit', 'the file is larger than 32,768 bytes'],
  ];
  return names.filter(([key]) => !checks[key]).map(([, label]) => label);
}

function mtaIssues(mta: MtaStsResult): ScanIssue[] {
  const issues: ScanIssue[] = [];
  if (mta.recordProblem) {
    issues.push(
      issue({
        code: 'mta_sts_record_invalid',
        title: 'MTA-STS record cannot be used',
        message: mta.recordProblem,
        recommendation: 'Keep exactly one v=STSv1 record with an id of 1 to 32 letters or digits.',
      }),
    );
  }

  if (mta.policy?.status === 'unavailable') {
    issues.push(
      issue({
        code: 'mta_sts_policy_unavailable',
        title: 'MTA-STS policy could not be fetched',
        message: `${mta.policy.detail ? `${mta.policy.detail} ` : ''}Senders that have not cached a policy deliver as if there were none; senders that cached an earlier one keep applying it.`,
        recommendation: `Serve the policy at ${mta.policy.url} over valid HTTPS.`,
      }),
    );
  }

  if (mta.policy?.status === 'invalid') {
    issues.push(
      issue({
        code: 'mta_sts_policy_invalid',
        title: 'MTA-STS policy is not valid',
        message: mta.policy.problems.join(' ') || mta.policy.detail || 'The policy could not be parsed.',
        recommendation: 'Serve a text/plain policy with version, mode, max_age and at least one mx host unless mode is none.',
      }),
    );
  }

  const uncovered = (mta.mxCoverage ?? []).filter((entry) => !entry.covered).map((entry) => entry.host);
  if (uncovered.length > 0 && mta.policy?.status === 'fetched' && mta.policy.mode !== 'none') {
    const enforce = mta.policy.mode === 'enforce';
    issues.push({
      severity: enforce ? 'error' : 'warning',
      code: 'mta_sts_mx_not_covered',
      title: 'MTA-STS policy does not cover every MX host',
      message: enforce
        ? `${uncovered.join(', ')} ${uncovered.length === 1 ? 'is' : 'are'} not covered by the policy. Senders that apply MTA-STS will refuse to deliver to ${uncovered.length === 1 ? 'it' : 'them'}.`
        : `${uncovered.join(', ')} ${uncovered.length === 1 ? 'is' : 'are'} not covered by the policy. While mode is testing, senders may still deliver and report the mismatch.`,
      recommendation: 'Add every receiving MX host to the mx list, or use a wildcard that covers it.',
    });
  }

  return issues;
}

function tlsRptIssues(tlsRpt: TlsRptResult): ScanIssue[] {
  if (tlsRpt.status === 'found' && !tlsRpt.valid) {
    return [
      issue({
        code: 'tls_rpt_record_invalid',
        title: 'TLS-RPT record is not valid',
        message: tlsRpt.problems.join(' ') || 'The TLS-RPT record could not be read.',
        recommendation: 'Publish one v=TLSRPTv1 record with a rua= list of mailto: or https: addresses.',
      }),
    ];
  }
  return [];
}

function bimiIssues(bimi: BimiResult): ScanIssue[] {
  const issues: ScanIssue[] = [];
  if (bimi.status !== 'found' || bimi.declined) {
    return issues;
  }

  if (bimi.problems.length > 0) {
    issues.push(
      issue({
        code: 'bimi_record_invalid',
        title: 'BIMI record is not valid',
        message: bimi.problems.join(' '),
        recommendation: 'Publish one v=BIMI1 record with an https l= logo URL and, optionally, an https a= certificate URL.',
      }),
    );
  }

  // A subdomain relying on its parent's DMARC record cannot be judged from
  // this scan; the scan detail says so instead of raising a false warning.
  if (!bimi.dmarc.qualifies && !bimi.dmarc.dependsOnParent) {
    issues.push(
      issue({
        code: 'bimi_dmarc_not_enforced',
        title: 'BIMI will not display until DMARC is enforced',
        message: `${bimi.dmarc.reasons.join(' ')} No mailbox provider will show the logo until DMARC is at quarantine or reject.`,
        recommendation: 'Move the DMARC policy to quarantine or reject, and check the parent domain when this is a subdomain.',
      }),
    );
  }

  if (bimi.logo?.status === 'unavailable') {
    issues.push(
      issue({
        code: 'bimi_logo_unavailable',
        title: 'BIMI logo could not be fetched',
        message: bimi.logo.detail ?? 'The logo URL could not be read over HTTPS.',
        recommendation: 'Serve the logo over valid HTTPS with a public certificate.',
      }),
    );
  }

  if (bimi.logo?.status === 'invalid') {
    const failures = bimi.logo.checks ? failedChecks(bimi.logo.checks) : [];
    issues.push(
      issue({
        code: 'bimi_logo_invalid',
        title: 'BIMI logo failed basic checks',
        message:
          failures.length > 0
            ? `A basic SVG Tiny PS check failed: ${failures.join('; ')}.`
            : (bimi.logo.detail ?? 'The logo could not be parsed as an SVG Tiny PS file.'),
        recommendation:
          'Publish an SVG Tiny PS 1.2 file (baseProfile="tiny-ps", version="1.2", a title, no script or external references) under 32,768 bytes. These are basic checks, not a full validation.',
      }),
    );
  }

  return issues;
}

async function mtaStsScan(
  domain: string,
  reader: DnsReader,
  https: HttpsGetter,
): Promise<{ result: MtaStsResult; fetchPromise: Promise<MtaStsResult> | null }> {
  const lookup = await reader.resolveTxt(`_mta-sts.${domain}`);
  if (lookup.status === 'error') {
    return {
      result: { status: 'error', policy: null, error: lookup.error },
      fetchPromise: null,
    };
  }

  const parsed = parseMtaStsTxt(lookup.value ?? []);
  if (parsed.status !== 'found' || parsed.recordProblem || !parsed.id) {
    return { result: parsed, fetchPromise: null };
  }

  const url = `https://mta-sts.${domain}/.well-known/mta-sts.txt`;
  const fetchPromise = https
    .get(url, { maxBytes: mtaStsPolicyBytes, accept: 'text/plain' })
    .then((fetched): MtaStsResult => {
      if (fetched.status === 'error') {
        return {
          ...parsed,
          policy: {
            url,
            status: 'unavailable',
            failure: fetched.failure,
            ...(fetched.statusCode !== undefined ? { httpStatus: fetched.statusCode } : {}),
            detail: fetched.detail,
            problems: [],
          },
        };
      }

      const mediaType = (fetched.contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
      if (mediaType !== 'text/plain') {
        const detail = `Served as ${mediaType || 'no content type'}, not text/plain. Senders that check the media type ignore the policy.`;
        return {
          ...parsed,
          policy: {
            url,
            status: 'invalid',
            failure: 'content_type',
            httpStatus: 200,
            detail,
            problems: [detail],
            text: fetched.body.toString('utf8').slice(0, 2_000),
          },
        };
      }

      const policy = parseMtaStsPolicy(fetched.body.toString('utf8'), fetched.contentType);
      return {
        ...parsed,
        policy: {
          url,
          status: policy.valid ? 'fetched' : 'invalid',
          httpStatus: 200,
          ...(policy.mode ? { mode: policy.mode } : {}),
          ...(policy.maxAge !== undefined ? { maxAge: policy.maxAge } : {}),
          ...(policy.mx ? { mx: policy.mx } : {}),
          problems: policy.contentTypeProblem ? [policy.contentTypeProblem, ...policy.problems] : policy.problems,
          text: policy.text,
        },
      };
    });

  return { result: parsed, fetchPromise };
}

function mtaWithCoverage(mta: MtaStsResult, mx: MxResult): MtaStsResult {
  if (mta.policy?.status !== 'fetched' || mx.records.length === 0) {
    return mta;
  }
  const patterns = mta.policy.mx ?? [];
  return {
    ...mta,
    mxCoverage: mx.records.map((record) => ({
      host: record.exchange,
      covered: mxCoveredBy(record.exchange, patterns),
    })),
  };
}

async function bimiScan(
  domain: string,
  reader: DnsReader,
  https: HttpsGetter,
  dmarc: DmarcResult,
): Promise<{ result: BimiResult; fetchPromise: Promise<BimiResult> | null }> {
  const qualification = bimiDmarcQualification(dmarc, domain);
  const lookup = await reader.resolveTxt(`default._bimi.${domain}`);
  if (lookup.status === 'error') {
    return {
      result: {
        status: 'error',
        logoUrl: null,
        authorityUrl: null,
        declined: false,
        problems: [],
        dmarc: qualification,
        logo: null,
        error: lookup.error,
      },
      fetchPromise: null,
    };
  }

  let parsed = parseBimiTxt(lookup.value ?? []);
  let inheritedFrom: string | undefined;
  const org = organizationalDomain(domain);
  if (parsed.status === 'missing' && org && org !== domain) {
    const inherited = await reader.resolveTxt(`default._bimi.${org}`);
    if (inherited.status === 'error') {
      return {
        result: {
          status: 'error',
          logoUrl: null,
          authorityUrl: null,
          declined: false,
          problems: [],
          dmarc: qualification,
          logo: null,
          error: inherited.error,
        },
        fetchPromise: null,
      };
    }
    parsed = parseBimiTxt(inherited.value ?? []);
    if (parsed.status === 'found') {
      inheritedFrom = org;
    }
  }

  const result: BimiResult = {
    status: parsed.status,
    ...(parsed.record ? { record: parsed.record } : {}),
    ...(inheritedFrom ? { inheritedFrom } : {}),
    logoUrl: parsed.logoUrl,
    authorityUrl: parsed.authorityUrl,
    declined: parsed.declined,
    problems: parsed.problems,
    dmarc: qualification,
    logo: null,
  };

  if (
    parsed.status !== 'found' ||
    parsed.declined ||
    parsed.multiple ||
    // Null whenever l= is missing or not an https URL, so a bad l= is never
    // fetched; a bad a= alone still lets the logo be checked.
    !parsed.logoUrl
  ) {
    return { result, fetchPromise: null };
  }

  const logoUrl = parsed.logoUrl;
  const fetchPromise = https
    .get(logoUrl, { maxBytes: bimiLogoBytes, accept: 'image/svg+xml' })
    .then((fetched): BimiResult => {
      if (fetched.status === 'error') {
        if (fetched.failure === 'too_large') {
          return {
            ...result,
            logo: {
              status: 'invalid',
              detail: 'The logo is larger than 32,768 bytes.',
              checks: {
                svgRoot: false,
                tinyPsProfile: false,
                version12: false,
                title: false,
                noForbiddenElements: false,
                noExternalReferences: false,
                withinSizeLimit: false,
              },
            },
          };
        }
        return {
          ...result,
          logo: {
            status: 'unavailable',
            failure: fetched.failure,
            detail: fetched.detail,
          },
        };
      }

      const checks = inspectBimiSvg(fetched.body);
      const passed = Object.values(checks).every(Boolean);
      return {
        ...result,
        logo: {
          status: passed ? 'fetched' : 'invalid',
          ...(passed ? {} : { detail: `Basic checks failed: ${failedChecks(checks).join('; ')}.` }),
          bytes: fetched.body.length,
          checks,
        },
      };
    });

  return { result, fetchPromise };
}

export async function scanTransportRecords(input: {
  domain: string;
  reader: DnsReader;
  https: HttpsGetter;
  dmarc: DmarcResult;
  mx: MxResult;
}): Promise<TransportScan> {
  const [mtaStarted, tlsLookup, bimiStarted] = await Promise.all([
    mtaStsScan(input.domain, input.reader, input.https),
    input.reader.resolveTxt(`_smtp._tls.${input.domain}`),
    bimiScan(input.domain, input.reader, input.https, input.dmarc),
  ]);

  const [mtaFetched, bimiFetched] = await Promise.all([
    mtaStarted.fetchPromise ?? Promise.resolve(mtaStarted.result),
    bimiStarted.fetchPromise ?? Promise.resolve(bimiStarted.result),
  ]);

  const mtaSts = mtaWithCoverage(mtaFetched, input.mx);
  const tlsRpt: TlsRptResult =
    tlsLookup.status === 'error'
      ? {
          status: 'error',
          valid: false,
          mailtoTargets: [],
          httpsTargets: [],
          problems: [],
          error: tlsLookup.error,
        }
      : parseTlsRptTxt(tlsLookup.value ?? []);

  return {
    mtaSts,
    tlsRpt,
    bimi: bimiFetched,
    issues: [...mtaIssues(mtaSts), ...tlsRptIssues(tlsRpt), ...bimiIssues(bimiFetched)],
  };
}
