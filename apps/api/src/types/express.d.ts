import { auth } from '../auth/auth.config.js';

type AuthSession = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>;

declare global {
  namespace Express {
    interface Locals {
      session: AuthSession;
      organizationId: string;
    }
  }
}

export {};
