import { betterAuth } from 'better-auth';
import { prismaAdapter } from '@better-auth/prisma-adapter';
import { organization } from 'better-auth/plugins';
import { createAuthMiddleware, APIError } from 'better-auth/api';
import { env } from '../config/env.js';
import { prisma } from '../database/prisma.js';
import { recordAuditEvent } from '../services/audit.service.js';
import { accessControl, organizationRoles } from './permissions.js';
import { queueAuthEmail, queueEmail } from '../email/email.service.js';
import { workspaceInvitationEmail } from '../email/templates.js';

const socialProviders = {
  ...(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
    ? {
        google: {
          clientId: env.GOOGLE_CLIENT_ID,
          clientSecret: env.GOOGLE_CLIENT_SECRET,
          prompt: 'select_account' as const,
          requireEmailVerification: true,
        },
      }
    : {}),
  ...(env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET
    ? {
        microsoft: {
          clientId: env.MICROSOFT_CLIENT_ID,
          clientSecret: env.MICROSOFT_CLIENT_SECRET,
          tenantId: env.MICROSOFT_TENANT_ID,
          prompt: 'select_account' as const,
        },
      }
    : {}),
};

export const auth = betterAuth({
  appName: 'DMARC Harbor',
  baseURL: env.BETTER_AUTH_URL,
  secret: env.BETTER_AUTH_SECRET,
  database: prismaAdapter(prisma, { provider: 'postgresql' }),
  trustedOrigins: env.CORS_ORIGINS,
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    maxPasswordLength: 128,
    autoSignIn: false,
    requireEmailVerification: true,
    revokeSessionsOnPasswordReset: true,
    resetPasswordTokenExpiresIn: 60 * 60,
    sendResetPassword: async ({ user, url }) => {
      queueAuthEmail({
        to: user.email,
        subject: 'Reset your DMARC Harbor password',
        text: `Reset your password using this link: ${url}\n\nIf you did not request this, you can ignore this email.`,
      });
    },
    /**
     * Warns the owner of an existing account that someone tried to sign up with it.
     *
     * This hook cannot refuse the request, and it is worth being explicit about why
     * rather than leaving a throw here that looks load-bearing. Better Auth computes
     * `shouldReturnGenericDuplicateResponse = requireEmailVerification || autoSignIn === false`
     * and we set both, so on a duplicate it runs this hook through
     * `runInBackgroundOrAwait` and answers 200 with a synthetic user, deliberately,
     * so the response cannot be used to enumerate which addresses have accounts.
     * A throw here is discarded.
     *
     * The consequence is a frontend obligation, not a server one: the sign-up form
     * must not claim an account was created. It says a link was sent if one can be,
     * which is true either way. The enumeration protection is the point; pretending
     * success is what had to go.
     */
    onExistingUserSignUp: async ({ user }) => {
      queueAuthEmail({
        to: user.email,
        subject: 'Someone tried to sign up with your email',
        text: 'Someone tried to create a DMARC Harbor account using this email address. If this was you, sign in instead. If not, you can ignore this email.',
      });
    },
  },
  emailVerification: {
    sendOnSignUp: true,
    sendOnSignIn: true,
    autoSignInAfterVerification: true,
    expiresIn: 60 * 60 * 24,
    sendVerificationEmail: async ({ user, url }) => {
      queueAuthEmail({
        to: user.email,
        subject: 'Verify your DMARC Harbor email',
        text: `Verify your email address using this link: ${url}\n\nThe link expires in 24 hours.`,
      });
    },
  },
  socialProviders,
  session: {
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24,
  },
  advanced: {
    database: {
      joins: true,
    },
  },
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== '/change-password') {
        return;
      }

      const body = ctx.body as { currentPassword?: unknown; newPassword?: unknown; revokeOtherSessions?: unknown } | undefined;
      if (!body) {
        return;
      }

      if (typeof body.newPassword === 'string' && body.newPassword === body.currentPassword) {
        throw new APIError('BAD_REQUEST', {
          message: 'The new password must be different from the current password.',
        });
      }

      body.revokeOtherSessions = true;
    }),
    after: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== '/change-password' || !ctx.context.returned) {
        return;
      }

      const newSession = ctx.context.newSession;
      if (!newSession?.user?.id) {
        return;
      }

      try {
        await recordAuditEvent({
          actorUserId: newSession.user.id,
          action: 'PASSWORD_CHANGED',
          targetType: 'user',
          targetId: newSession.user.id,
          detail: { revokedOtherSessions: true, sessionRotated: true },
        });
      } catch (error) {
        console.error('Failed to record password change audit event', error);
      }
    }),
  },
  plugins: [
    organization({
      ac: accessControl,
      roles: organizationRoles,
      allowUserToCreateOrganization: () => true,
      requireEmailVerificationOnInvitation: true,
      // Without this the plugin sent nothing, and an invited person never
      // learned they had been invited. The link opens the web app's /welcome,
      // which lists invitations waiting for the signed-in address.
      async sendInvitationEmail(data) {
        queueEmail(
          workspaceInvitationEmail({
            workspaceName: data.organization.name,
            inviterName: data.inviter.user.name?.trim() || data.inviter.user.email,
            role: data.role,
            signInUrl: `${env.APP_URL.replace(/\/$/, '')}/welcome`,
            expiresAt: data.invitation.expiresAt ? new Date(data.invitation.expiresAt).toISOString() : null,
          }),
          data.email,
          `invitation:${data.id}:${new Date(data.invitation.expiresAt ?? Date.now()).getTime()}`,
        );
      },
    }),
  ],
});
