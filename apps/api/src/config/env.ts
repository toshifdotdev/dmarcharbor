import { config } from 'dotenv';
import { z } from 'zod';

config();

const developmentSecret = 'dmarcharbor-development-only-secret-change-me';
const developmentForensicSecret = 'dmarcharbor-development-only-forensic-secret-change-me';
const developmentPiiKey = 'dmarcharbor-development-only-pii-encryption-key-change-me';
const optionalSecret = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().trim().min(1).optional(),
);
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
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
  ALERT_SCHEDULER_DISABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
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

// A half configured provider is worse than an unconfigured one, because it
// fails at the point of taking a payment rather than at boot.
if (Boolean(parsed.data.RAZORPAY_KEY_ID) !== Boolean(parsed.data.RAZORPAY_KEY_SECRET)) {
  throw new Error('RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET must be configured together.');
}
if (Boolean(parsed.data.PADDLE_API_KEY) !== Boolean(parsed.data.PADDLE_WEBHOOK_SECRET)) {
  throw new Error('PADDLE_API_KEY and PADDLE_WEBHOOK_SECRET must be configured together.');
}

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
  // Both URLs are also baked into emails the customer receives: erasure
  // cancellation and export download links are built from BETTER_AUTH_URL.
  for (const name of ['BETTER_AUTH_URL', 'APP_URL'] as const) {
    const value = parsed.data[name];
    if (!value.startsWith('https://')) {
      throw new Error(`${name} must be an https URL in production.`);
    }
  }
}

export const env = {
  ...parsed.data,
  CORS_ORIGINS: parsed.data.CORS_ORIGIN.split(',').map((origin) => origin.trim()),
};
