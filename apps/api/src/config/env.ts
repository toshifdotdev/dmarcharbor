import { config } from 'dotenv';
import { z } from 'zod';

config();

const developmentSecret = 'dmarcharbor-development-only-secret-change-me';
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().url().default('postgresql://dmarcharbor:dmarcharbor@localhost:5432/dmarcharbor'),
  BETTER_AUTH_SECRET: z.string().min(32).default(developmentSecret),
  BETTER_AUTH_URL: z.string().url().default('http://localhost:4000'),
  CORS_ORIGIN: z.string().url().default('http://localhost:5173'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  throw new Error(`Invalid environment configuration: ${parsed.error.message}`);
}

if (parsed.data.NODE_ENV === 'production' && parsed.data.BETTER_AUTH_SECRET === developmentSecret) {
  throw new Error('BETTER_AUTH_SECRET must be set in production.');
}

export const env = {
  ...parsed.data,
  CORS_ORIGINS: parsed.data.CORS_ORIGIN.split(',').map((origin) => origin.trim()),
};
