import { config } from 'dotenv';
import { z } from 'zod';

config();

const developmentSecret = 'dmarcharbor-development-only-secret-change-me';
const developmentForensicSecret = 'dmarcharbor-development-only-forensic-secret-change-me';
const developmentPiiKey = 'dmarcharbor-development-only-pii-encryption-key-change-me';
const developmentEmailFrom = 'DMARC Harbor <no-reply@dmarcharbor.com>';
const developmentAggregateAddress = 'dmarc-reports@reports.dmarcharbor.com';
const developmentForensicAddress = 'dmarc-forensics@reports.dmarcharbor.com';
const optionalSecret = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().trim().min(1).optional(),
);

/**
 * True when a value is a bare origin: a scheme, a host and optionally a port,
 * and nothing else. `new URL` turns `https://example.com` into a pathname of
 * `/`, so that one trailing slash is the only path shape accepted; anything
 * else means the operator wrote a URL and the URLs we build from it would be
 * `https://example.com/path/bimi/...`, which serves nothing.
 */
export function isOriginOnly(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    if (url.username || url.password || url.search || url.hash) return false;
    return url.pathname === '/';
  } catch {
    return false;
  }
}
const envSchema = z.object({
  /**
   * Fails closed on anything unrecognised, including absent.
   *
   * This defaulted to `development`, and every production guard below is nested
   * inside `if (NODE_ENV === 'production')`. So a deploy that forgot the variable
   * - a platform that injects nothing, `node dist/server.js` instead of the
   * entrypoint, a `docker run` that overrides only DATABASE_URL - booted green with
   * every guard off, and signed session cookies with the development secret below.
   * Anyone who has read this repository could mint a session for any user.
   *
   * Treating absent as `production` is the safe direction to be wrong in: a local
   * checkout that has not set NODE_ENV gets a loud refusal and sets it, whereas the
   * other direction is a working deployment with no guards and no signal. The dev
   * container and compose set it explicitly, as does vitest, so nothing legitimate
   * depends on the old default.
   */
  NODE_ENV: z.enum(['development', 'test', 'production']).catch('production'),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().url().default('postgresql://dmarcharbor:dmarcharbor@localhost:5432/dmarcharbor'),
  BETTER_AUTH_SECRET: z.string().min(32).default(developmentSecret),
  BETTER_AUTH_URL: z.string().url().default('http://localhost:4000'),
  CORS_ORIGIN: z.string().url().default('http://localhost:5173'),
  /**
   * Where the browser application lives, as opposed to where this API lives.
   *
   * Payment providers bounce the customer back to a URL we hand them after a
   * checkout or a card update. Those must point at the web app, not at this API's
   * own origin, or the customer finishes paying and lands on a JSON endpoint. The
   * two are separate deployments and separate hosts in production.
   */
  APP_URL: z.string().url().default('http://localhost:3100'),
  EMAIL_PROVIDER: z.enum(['console', 'resend']).default('console'),
  /**
   * How long a shutdown is allowed to take before the process is killed anyway.
   *
   * Thirty seconds is longer than the requests this service considers reasonable
   * and shorter than a typical platform grace period, so the drain normally
   * finishes on its own terms and the deadline is the backstop rather than the
   * mechanism. It used to be read straight from `process.env` with `Number(...)`,
   * which accepted `"abc"` as `NaN` and `setTimeout(fn, NaN)` fires immediately:
   * a typo turned a graceful drain into an instant exit with requests in flight.
   */
  SHUTDOWN_DRAIN_MS: z.coerce.number().int().positive().max(300_000).default(30_000),
  EMAIL_FROM: z.string().trim().min(3).default('DMARC Harbor <no-reply@dmarcharbor.com>'),
  RESEND_API_KEY: optionalSecret,
  GOOGLE_CLIENT_ID: optionalSecret,
  GOOGLE_CLIENT_SECRET: optionalSecret,
  MICROSOFT_CLIENT_ID: optionalSecret,
  MICROSOFT_CLIENT_SECRET: optionalSecret,
  MICROSOFT_TENANT_ID: z.string().trim().min(1).default('common'),
  REPORT_INGEST_SECRET: optionalSecret,
  /**
   * Server side credential for the support operations that have to change a
   * plan outside a paid flow, such as honouring a contract rate or correcting a
   * provider webhook that never arrived.
   *
   * Deliberately not a workspace permission. A plan is what money buys, so the
   * ability to grant one cannot sit in the same role table as the ability to
   * read a client's domains. When it is unset the operations are simply absent
   * rather than open, so a deployment that has not configured it cannot be
   * written into by accident.
   */
  STAFF_API_KEY: optionalSecret,

  // Razorpay. Absent until a merchant account exists, so the app still boots
  // and the billing routes report a clear 503 rather than failing to start.
  RAZORPAY_KEY_ID: optionalSecret,
  RAZORPAY_KEY_SECRET: optionalSecret,
  /** Separate secret for webhook signature verification, never the API key secret. */
  RAZORPAY_WEBHOOK_SECRET: optionalSecret,

  // Paddle. A vendor id for API calls, plus a separate client secret used only
  // to verify that an incoming webhook genuinely came from Paddle.
  PADDLE_API_KEY: optionalSecret,
  PADDLE_WEBHOOK_SECRET: optionalSecret,

  // Logo storage. Absent until a bucket exists, so branding still works with a
  // logo URL pasted in, and upload simply reports that it is not configured.
  AWS_REGION: optionalSecret,
  LOGO_BUCKET: optionalSecret,
  LOGO_CDN_ORIGIN: optionalSecret,
  // Optional. On AWS these come from the instance role and need not be set at
  // all, so an unsigned local setup still works.
  AWS_ACCESS_KEY_ID: optionalSecret,
  AWS_SECRET_ACCESS_KEY: optionalSecret,
  /** Public asset origin, so it can be registered as its own CSP scope. */
  ASSETS_ORIGIN: optionalSecret,
  FORENSIC_PSEUDONYM_SECRET: z.string().min(32).default(developmentForensicSecret),
  FORENSIC_PII_ENCRYPTION_KEY: z.string().min(32).default(developmentPiiKey),
  FORENSIC_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  FORENSIC_PII_RETENTION_DAYS: z.coerce.number().int().min(1).max(30).default(7),
  ALERT_EVALUATION_INTERVAL_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
  DOMAIN_REVERIFY_INTERVAL_MINUTES: z.coerce.number().int().min(1).max(1440).default(60),
  // Dunning withdraws a plan after a failed payment, so it runs daily rather
  // than on every alert tick.
  BILLING_DUNNING_INTERVAL_MINUTES: z.coerce.number().int().min(15).max(10080).default(1440),
  // Reconciliation repairs drift a missed webhook would otherwise leave behind.
  BILLING_RECONCILE_INTERVAL_MINUTES: z.coerce.number().int().min(15).max(10080).default(360),
  // Senders deliver by the day, so a short interval buys nothing and costs a
  // login to a third party mail host every few minutes.
  REPORT_INBOX_POLL_INTERVAL_MINUTES: z.coerce.number().int().min(5).max(1440).default(120),
  ALERT_ROLLUP_HOURS: z.coerce.number().int().min(1).max(168).default(24),
  ALERT_STALE_DAYS: z.coerce.number().int().min(1).max(365).default(7),
  REPORT_RETENTION_DAYS: z.coerce.number().int().min(7).max(3650).default(400),

  // A customer's full dataset, in one row, with a purge date already stamped on
  // it. Nothing was reading that date, so every export ever issued was kept for
  // ever and the export job table was the largest concentration of personal data
  // in the service.
  EXPORT_JOB_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(7),

  // An idempotency record stores the whole response body, which for a checkout
  // call includes client ids and DNS verification values. A day is generous for
  // replaying a request that a network dropped; keeping them longer only grows the
  // table.
  IDEMPOTENCY_RECORD_RETENTION_HOURS: z.coerce.number().int().min(1).max(720).default(24),

  // How many documents may be built at once.
  //
  // PDF generation buffers the whole file and holds it twice while the hash is
  // computed, so unbounded concurrency is a few hundred megabytes per request and an
  // out-of-memory kill that takes down every tenant's API rather than one pack.
  PDF_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),

  // Brake for signed-in traffic. Generous on purpose: an agency legitimately
  // importing several hundred domains in one action must not be caught by it.
  WORKSPACE_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(10).max(10_000).default(600),

  // Abandoned SSO starts. Consumed ones are removed at the callback, but a user who
  // closes the tab at the identity provider leaves a row, with a PKCE verifier and
  // a RelayState in it, that nothing ever collects.
  SSO_REQUEST_RETENTION_HOURS: z.coerce.number().int().min(1).max(720).default(24),

  // The provider's raw webhook body. The typed columns beside it are what the
  // service reasons about and the provider keeps its own copy, so three months is
  // long enough to investigate a billing dispute from our own record.
  BILLING_PAYLOAD_RETENTION_DAYS: z.coerce.number().int().min(7).max(3650).default(90),
  REPORT_AGGREGATE_ADDRESS: z
    .string()
    .trim()
    .email()
    .default('dmarc-reports@reports.dmarcharbor.com'),
  REPORT_FORENSIC_ADDRESS: z.string().trim().email().default('dmarc-forensics@reports.dmarcharbor.com'),
  /** Optional separate mailbox for TLS-RPT; defaults to the aggregate address. */
  REPORT_TLSRPT_ADDRESS: z.string().trim().email().optional(),
  /**
   * Whether each client gets its own report address.
   *
   * `off` keeps the single shared mailbox address, and report-address ownership
   * is disabled. `plus` builds `local+token@domain` addresses from
   * REPORT_AGGREGATE_ADDRESS. The token is part of the address and does not
   * change routing, which stays keyed on the report's policy domain.
   *
   * Turning this on is only half the change: the inbound MTA must also deliver
   * `local+anything@domain` to the same mailbox or relay, or reports bounce.
   * The boot guard below refuses a base local part that already contains `+`,
   * because appending a second one would make the address ambiguous.
   */
  REPORT_ADDRESS_SUBADDRESSING: z.enum(['off', 'plus']).default('off'),
  ALERT_SCHEDULER_DISABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  /**
   * The PSA outbox drain interval.
   *
   * Sixty seconds keeps a ticket close to the alert that raised it without
   * hammering a PSA: Autotask allows three concurrent threads per endpoint and
   * roughly ten thousand requests an hour, and the worker is serial per
   * connection.
   */
  PSA_DELIVERY_INTERVAL_SECONDS: z.coerce.number().int().min(15).max(3600).default(60),
  /** Turns the PSA outbox drain off without disabling every other scheduler. */
  PSA_SCHEDULER_DISABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  /**
   * ConnectWise's clientId header.
   *
   * Deployment-wide, not per customer: ConnectWise issues one to the vendor of
   * the integration, free, and every API member call must send it. Without it
   * the ConnectWise option is simply not offered, because a connection that
   * cannot authenticate is worse than one that is absent.
   */
  PSA_CONNECTWISE_CLIENT_ID: optionalSecret,
  /**
   * Continuous DNS monitoring. Every verified domain is rescanned on the
   * interval below; the tick only decides how often work is looked for.
   */
  DNS_MONITOR_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  DNS_MONITOR_INTERVAL_MINUTES: z.coerce.number().int().min(60).max(10080).default(1440),
  DNS_MONITOR_TICK_MINUTES: z.coerce.number().int().min(1).max(60).default(10),
  DNS_MONITOR_BATCH_SIZE: z.coerce.number().int().min(1).max(200).default(30),
  DNS_MONITOR_CONCURRENCY: z.coerce.number().int().min(1).max(10).default(3),
  /**
   * How many unseen sending IPs one sender-intelligence pass may look up.
   *
   * The lookups are public DNS only, but each pass is background work shared
   * with alerts and billing; a bound keeps a backlog from becoming a resolver
   * flood. Five lookups run at a time.
   */
  SENDER_INTEL_BATCH: z.coerce.number().int().min(1).max(2000).default(300),
  /**
   * How many reverse proxies sit in front of this process, so Express can trust
   * the leftmost `X-Forwarded-For` entry and rate limiters can key on the real
   * client address rather than on the proxy's.
   *
   * Zero means trust nothing and use the socket address, which is correct when
   * nothing is in front. A wrong non-zero value lets a client forge its own
   * source address and walk straight through every IP keyed limit, so this fails
   * closed to zero rather than guessing.
   */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
  /**
   * Sign-in attempts allowed per client address per minute.
   *
   * There is no MFA in this product, so this is the primary control on
   * credential stuffing rather than a secondary one. Configurable because the
   * integration suite authenticates dozens of times from one address and would
   * otherwise trip it for reasons that have nothing to do with the limit.
   */
  AUTH_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(10_000).default(20),
  /** Authenticated requests allowed per API key per minute. */
  API_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(100_000).default(300),
  /** Unauthenticated report share views allowed per client per minute. */
  PUBLIC_REPORT_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(100_000).default(30),
  /** On-demand domain scans allowed per client per minute. */
  SCAN_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(100_000).default(20),
  /** Inbound DMARC report deliveries accepted per client per minute. */
  REPORT_INGEST_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(100_000).default(30),
  /** SSO start and callback requests allowed per client per minute. */
  SESSION_ROUTER_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(100_000).default(10),

  /**
   * Hosted DMARC records. All three are required for the feature to switch on;
   * a partial set is refused at boot rather than serving a half-configured zone.
   *
   * HOSTED_DNS_ZONE is a whole registered domain on Cloudflare. Subdomain zones
   * need an Enterprise plan, so the common deployment is the registrable domain.
   */
  HOSTED_DNS_ZONE: z
    .string()
    .trim()
    .toLowerCase()
    .refine(
      (value) =>
        /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value) &&
        !value.endsWith('.'),
      'HOSTED_DNS_ZONE must be a lowercase hostname with at least two labels and no trailing dot.',
    )
    .optional(),
  HOSTED_DNS_CLOUDFLARE_TOKEN: optionalSecret,
  HOSTED_DNS_CLOUDFLARE_ZONE_ID: z
    .string()
    .trim()
    .regex(/^[a-fA-F0-9]{32}$/, 'HOSTED_DNS_CLOUDFLARE_ZONE_ID must be 32 hexadecimal characters.')
    .optional(),
  /** Cloudflare Free holds 200 records; Pro and Business hold 3,500. */
  HOSTED_DNS_RECORD_LIMIT: z.coerce.number().int().min(1).max(1_000_000).default(200),
  /**
   * The hostname every customer's `mta-sts.<domain>` CNAME points at.
   *
   * Must live inside HOSTED_DNS_ZONE, because that is the zone whose Cloudflare
   * for SaaS subscription issues the certificates. Hosted MTA-STS is available
   * only when this is set and the hosted zone is configured.
   */
  HOSTED_MTA_STS_CNAME_TARGET: z
    .string()
    .trim()
    .toLowerCase()
    .refine(
      (value) =>
        /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value) &&
        !value.endsWith('.'),
      'HOSTED_MTA_STS_CNAME_TARGET must be a lowercase hostname with at least two labels and no trailing dot.',
    )
    .optional(),
  /**
   * How many custom hostnames this deployment will hold.
   *
   * Cloudflare for SaaS includes 100 free and charges $0.10 per hostname per
   * month after that, so the default stops an operator paying by accident. The
   * hard ceiling is Cloudflare's own 50,000.
   */
  HOSTED_MTA_STS_HOSTNAME_LIMIT: z.coerce.number().int().min(1).max(50_000).default(100),
  /**
   * Where hosted BIMI logos and certificates are served from.
   *
   * An https origin with no path, query or fragment. Deliberately not APP_URL:
   * the web app runs a proxy on every path that rewrites headers, and an SVG
   * must not be served from the origin that holds the session cookie. Hosted
   * BIMI is available only when this is set and the hosted zone is configured.
   */
  HOSTED_BIMI_ORIGIN: z
    .string()
    .trim()
    .refine(isOriginOnly, 'HOSTED_BIMI_ORIGIN must be an origin such as https://bimi.example.com, with no path, query or fragment.')
    .optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  throw new Error(`Invalid environment configuration: ${parsed.error.message}`);
}

function assertPairedCredentials(name: string, clientId?: string, clientSecret?: string): void {
  if (Boolean(clientId) !== Boolean(clientSecret)) {
    throw new Error(`${name}_CLIENT_ID and ${name}_CLIENT_SECRET must be configured together.`);
  }
}

assertPairedCredentials('GOOGLE', parsed.data.GOOGLE_CLIENT_ID, parsed.data.GOOGLE_CLIENT_SECRET);
assertPairedCredentials('MICROSOFT', parsed.data.MICROSOFT_CLIENT_ID, parsed.data.MICROSOFT_CLIENT_SECRET);

if (
  parsed.data.REPORT_ADDRESS_SUBADDRESSING === 'plus' &&
  parsed.data.REPORT_AGGREGATE_ADDRESS.split('@')[0]?.includes('+')
) {
  throw new Error(
    'REPORT_AGGREGATE_ADDRESS local part must not contain "+" when REPORT_ADDRESS_SUBADDRESSING is plus: the client token is appended with one.',
  );
}

if (
  parsed.data.REPORT_ADDRESS_SUBADDRESSING === 'plus' &&
  parsed.data.REPORT_TLSRPT_ADDRESS?.split('@')[0]?.includes('+')
) {
  throw new Error(
    'REPORT_TLSRPT_ADDRESS local part must not contain "+" when REPORT_ADDRESS_SUBADDRESSING is plus: the client token is appended with one.',
  );
}

// A half configured provider is worse than an unconfigured one, because it
// fails at the point of taking a payment rather than at boot.
if (Boolean(parsed.data.RAZORPAY_KEY_ID) !== Boolean(parsed.data.RAZORPAY_KEY_SECRET)) {
  throw new Error('RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET must be configured together.');
}
if (Boolean(parsed.data.PADDLE_API_KEY) !== Boolean(parsed.data.PADDLE_WEBHOOK_SECRET)) {
  throw new Error('PADDLE_API_KEY and PADDLE_WEBHOOK_SECRET must be configured together.');
}

/**
 * Hosted DMARC is optional, but half of it is worse than none: a zone without a
 * token serves nothing, and a token without a zone has nowhere to write. The
 * refusal is outside the production block so it applies in every environment,
 * including the test one.
 */
export function assertHostedDnsConfig(input: {
  zone?: string;
  token?: string;
  zoneId?: string;
}): void {
  const configured = [input.zone, input.token, input.zoneId].filter(Boolean).length;
  if (configured > 0 && configured < 3) {
    throw new Error(
      'HOSTED_DNS_ZONE, HOSTED_DNS_CLOUDFLARE_TOKEN and HOSTED_DNS_CLOUDFLARE_ZONE_ID must be configured together.',
    );
  }
}

assertHostedDnsConfig({
  zone: parsed.data.HOSTED_DNS_ZONE,
  token: parsed.data.HOSTED_DNS_CLOUDFLARE_TOKEN,
  zoneId: parsed.data.HOSTED_DNS_CLOUDFLARE_ZONE_ID,
});

/**
 * The MTA-STS CNAME target has to be inside the hosted zone.
 *
 * Cloudflare for SaaS issues the certificate for a custom hostname from the
 * zone's own subscription, and the fallback origin is a record in that zone. A
 * target in some other zone would accept the CNAME and then never serve the
 * policy, which reads as "MTA-STS is broken" rather than "this deployment is
 * misconfigured". Refused at boot, in every environment.
 */
if (parsed.data.HOSTED_MTA_STS_CNAME_TARGET) {
  const target = parsed.data.HOSTED_MTA_STS_CNAME_TARGET;
  const zone = parsed.data.HOSTED_DNS_ZONE;
  if (!zone) {
    throw new Error('HOSTED_MTA_STS_CNAME_TARGET requires HOSTED_DNS_ZONE to be configured.');
  }
  if (target !== zone && !target.endsWith(`.${zone}`)) {
    throw new Error('HOSTED_MTA_STS_CNAME_TARGET must be a hostname inside HOSTED_DNS_ZONE.');
  }
}
const hostedDnsConfigured = [
  parsed.data.HOSTED_DNS_ZONE,
  parsed.data.HOSTED_DNS_CLOUDFLARE_TOKEN,
  parsed.data.HOSTED_DNS_CLOUDFLARE_ZONE_ID,
].filter(Boolean).length;

if (parsed.data.NODE_ENV === 'production' && parsed.data.BETTER_AUTH_SECRET === developmentSecret) {
  throw new Error('BETTER_AUTH_SECRET must be set in production.');
}

if (parsed.data.EMAIL_PROVIDER === 'resend' && !parsed.data.RESEND_API_KEY) {
  throw new Error('RESEND_API_KEY must be set when EMAIL_PROVIDER is resend.');
}

if (parsed.data.NODE_ENV === 'production' && parsed.data.EMAIL_PROVIDER !== 'resend') {
  throw new Error('Production requires EMAIL_PROVIDER=resend.');
}

if (parsed.data.NODE_ENV === 'production' && !parsed.data.REPORT_INGEST_SECRET) {
  throw new Error('REPORT_INGEST_SECRET must be set in production.');
}

if (parsed.data.NODE_ENV === 'production' && parsed.data.FORENSIC_PSEUDONYM_SECRET === developmentForensicSecret) {
  throw new Error('FORENSIC_PSEUDONYM_SECRET must be set in production.');
}

if (parsed.data.NODE_ENV === 'production' && parsed.data.FORENSIC_PII_ENCRYPTION_KEY === developmentPiiKey) {
  throw new Error('FORENSIC_PII_ENCRYPTION_KEY must be set in production.');
}

/**
 * `NODE_ENV` has to reach `process.env`, not just this module's parsed copy.
 *
 * Every production guard below keys off `parsed.data.NODE_ENV`, but the libraries
 * we do not control read `process.env.NODE_ENV` themselves. Express's final
 * handler is the one that matters: it returns `err.stack` in the body of every
 * unhandled 500 whenever that variable is anything other than `production`, so a
 * deploy that forgot to set NODE_ENV would hand database error text, SQL
 * fragments and absolute file paths to anonymous callers while looking
 * completely healthy. Writing it back makes our own guards and the framework's
 * behaviour agree, whichever way the platform spells it.
 */
process.env.NODE_ENV = parsed.data.NODE_ENV;

if (parsed.data.NODE_ENV === 'production') {
  /**
   * `DATABASE_URL` gets a development default so an unsigned local checkout
   * runs. In production that default is the dangerous case rather than the
   * convenient one: it points at a localhost database whose password matches
   * the one in compose.yaml, so a deploy that omits the variable either loops
   * on a failing readiness check forever or, worse, attaches to a co-located
   * development database and writes real customer data into it. Presence is
   * checked against the raw environment rather than the parsed value so the
   * default can never satisfy it.
   */
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL must be set explicitly in production.');
  }

  // Better Auth derives `useSecureCookies` from the baseURL protocol, so a plain
  // http default here means session cookies are issued without the Secure flag.
  // Both URLs are also baked into what the customer receives: every emailed
  // link (billing, erasure, export, portal) is built from APP_URL, and the
  // auth callbacks from BETTER_AUTH_URL.
  for (const name of ['BETTER_AUTH_URL', 'APP_URL'] as const) {
    const value = parsed.data[name];
    if (!value.startsWith('https://')) {
      throw new Error(`${name} must be an https URL in production.`);
    }
  }

  /**
   * The browser origin, for the same reason as the two above but worse.
   *
   * It defaulted to localhost, so a deploy that omitted it started green with
   * every browser request from the real web origin failing CORS preflight and
   * better-auth rejecting the origin outright. Server-to-server still worked,
   * which is exactly what makes it look fine: an SRE's curl passes and only
   * customers see nothing.
   */
  const origins = parsed.data.CORS_ORIGIN.split(',').map((origin) => origin.trim()).filter(Boolean);
  if (origins.length === 0) {
    throw new Error('CORS_ORIGIN must name at least one origin in production.');
  }
  for (const origin of origins) {
    // No loopback exemption. This guard's job is to stop a deploy that named a
    // localhost origin and therefore handed the browser a production deployment
    // whose session cookies and CORS answers are for a machine nobody can reach.
    // A platform that injects a loopback origin is describing itself wrongly, and
    // the loud refusal is the point.
    if (!origin.startsWith('https://')) {
      throw new Error('CORS_ORIGIN must contain an https URL in production.');
    }
  }

  /**
   * Where DMARC reports are delivered.
   *
   * Both default to `*.dmarcharbor.com`, so a deployment that did not override
   * them instructed every customer to route their reports to a mail domain they
   * do not own. The outcome is either a silent disclosure of their mail volume
   * and sending IPs to whoever holds that domain, or a deployment whose IMAP
   * poller never sees the reports - which reads as "my domain is broken" rather
   * than "this deployment is misconfigured". Staging is the worse case, because
   * it routes real customer traffic to the production mailbox.
   */
  if (parsed.data.REPORT_AGGREGATE_ADDRESS === developmentAggregateAddress) {
    throw new Error('REPORT_AGGREGATE_ADDRESS must be set in production.');
  }
  if (parsed.data.REPORT_FORENSIC_ADDRESS === developmentForensicAddress) {
    throw new Error('REPORT_FORENSIC_ADDRESS must be set in production.');
  }

  /**
   * The sender every outgoing email claims, which Resend verifies against the
   * account's domain. The default is `@dmarcharbor.com` on a deployment that may
   * not own it, and Resend then refuses every send - so sign-up verification,
   * password reset, domain verification, export-ready and both erasure notices
   * reach nobody while the queue quietly retries and dead-letters them.
   */
  if (parsed.data.EMAIL_FROM === developmentEmailFrom) {
    throw new Error('EMAIL_FROM must be set in production.');
  }

  /**
   * Where BIMI logos and certificates are served from.
   *
   * https because a BIMI logo URL must be https and mailbox providers refuse
   * anything else, so a plain-http origin publishes a record nobody can use.
   * A different origin from APP_URL because the web app's proxy runs on every
   * path and rewrites headers; serving an SVG from the origin that holds the
   * session cookie is a decision that cannot be undone quietly.
   */
  if (parsed.data.HOSTED_BIMI_ORIGIN) {
    const bimiOrigin = new URL(parsed.data.HOSTED_BIMI_ORIGIN);
    if (bimiOrigin.protocol !== 'https:') {
      throw new Error('HOSTED_BIMI_ORIGIN must be an https URL in production.');
    }
    if (bimiOrigin.origin === new URL(parsed.data.APP_URL).origin) {
      throw new Error(
        'HOSTED_BIMI_ORIGIN must be a different origin from APP_URL in production: the web app rewrites headers on every path, and an SVG must not be served from the origin that holds the session cookie.',
      );
    }
  }

  /**
   * How many proxies sit in front of this service.
   *
   * Zero meant every IP-keyed limiter saw the load balancer's address, so the
   * auth limiter's 20 per minute became 20 sign-ins per minute for the entire
   * customer base. The app warns rather than refusing because a wrong non-zero
   * value is the more dangerous setting of the two: it lets a client forge
   * `X-Forwarded-For` and get a fresh bucket per request. So the refusal is on
   * absence, which is the only case where the operator has said nothing.
   */
  if (!process.env.TRUST_PROXY_HOPS) {
    throw new Error('TRUST_PROXY_HOPS must be set explicitly in production.');
  }
}

export const env = {
  ...parsed.data,
  CORS_ORIGINS: parsed.data.CORS_ORIGIN.split(',').map((origin) => origin.trim()),
  HOSTED_DNS_ENABLED: hostedDnsConfigured === 3,
};
