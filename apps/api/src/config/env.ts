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
  FORENSIC_PSEUDONYM_SECRET: z.string().min(32).default(developmentForensicSecret),
  FORENSIC_PII_ENCRYPTION_KEY: z.string().min(32).default(developmentPiiKey),
  FORENSIC_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  FORENSIC_PII_RETENTION_DAYS: z.coerce.number().int().min(1).max(30).default(7),
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
