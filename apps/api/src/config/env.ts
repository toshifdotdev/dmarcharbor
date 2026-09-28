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

export const env = {
  ...parsed.data,
  CORS_ORIGINS: parsed.data.CORS_ORIGIN.split(',').map((origin) => origin.trim()),
};
