import { betterAuth } from 'better-auth';
import { organization } from 'better-auth/plugins';
import { env } from '../config/env.js';
import { pool } from '../database/pool.js';
import { accessControl, organizationRoles } from './permissions.js';

export const auth = betterAuth({
  appName: 'DMARC Harbor',
  baseURL: env.BETTER_AUTH_URL,
  secret: env.BETTER_AUTH_SECRET,
  database: pool,
  trustedOrigins: env.CORS_ORIGINS,
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    maxPasswordLength: 128,
    autoSignIn: true,
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24,
  },
  advanced: {
    database: {
      joins: true,
    },
  },
  plugins: [
    organization({
      ac: accessControl,
      roles: organizationRoles,
      allowUserToCreateOrganization: () => true,
      requireEmailVerificationOnInvitation: false,
    }),
  ],
});
