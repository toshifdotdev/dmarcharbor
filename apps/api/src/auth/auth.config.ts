import { betterAuth } from 'better-auth';
import { prismaAdapter } from '@better-auth/prisma-adapter';
import { organization, twoFactor } from 'better-auth/plugins';
import { createAuthMiddleware, APIError, getSessionFromCtx } from 'better-auth/api';
import { env } from '../config/env.js';
import { prisma } from '../database/prisma.js';
import { recordAuditEvent } from '../services/audit.service.js';
import { memberAllowance, memberLimitDetails, memberLimitMessage, resolveEntitlements } from '../services/entitlements/entitlement.service.js';
import { accessControl, organizationRoles } from './permissions.js';
import { queueAuthEmail, queueEmail } from '../email/email.service.js';
import { oneLine } from '../email/sender.js';
import {
  emailVerificationEmail,
  existingAccountSignUpEmail,
  passwordChangedEmail,
  passwordResetEmail,
  securityNoticeEmail,
  signInPausedEmail,
  workspaceInvitationEmail,
  type AuthEmailAgency,
} from '../email/templates.js';
import { agencyAuthLink, type AuthLink } from './agency-auth-link.js';
import { trustedOriginsFor } from './agency-origin.js';
import { passwordBreachCount } from './password-breach.js';
import {
  SIGN_IN_FAILURE_LIMIT,
  SIGN_IN_FAILURE_WINDOW_MS,
  SIGN_IN_PAUSE_MS,
  clearSignInFailures,
  recordSignInFailure,
  signInPause,
} from './sign-in-brake.js';
import {
  closeExpiredInvitationsReplacedBy,
  membershipAuditPaths,
  recordMembershipAudit,
  rememberPreviousRole,
} from './membership-audit.js';
import { socialProvidersFor } from './social-providers.js';
import { claimTotpCode, claimableCode, releaseTotpCode } from './totp-replay.js';

/**
 * Session creation is denied by default for a user with two-step verification.
 *
 * The plugin protects the password sign-in path, but it does not hook OAuth
 * callbacks, social sign-in or the auto sign-in after an email verification.
 * Those would otherwise mint a full session from a single factor. The allowlist
 * below is the small set of endpoints that already asked for the code and must
 * be able to rotate or create a session afterwards.
 *
 * The paths are Better Auth's route templates, not the request URL: the OAuth
 * callback arrives as `/callback/google` and is reported here as `/callback/:id`.
 */
const sessionPathsAllowedWithTwoFactor = new Set([
  '/sign-in/email',
  '/two-factor/verify-totp',
  '/two-factor/verify-backup-code',
  '/two-factor/enable',
  '/two-factor/disable',
  '/change-password',
]);

interface SessionGuardContext {
  path?: string;
}

interface SessionGuardSession {
  userId: string;
}

/**
 * Exported so the deny-by-default rule can be tested without a provider.
 *
 * `context` is absent for server-side session creation (tests and `auth.api`
 * calls), which is trusted code and is allowed. A present context is an HTTP
 * endpoint and is checked.
 */
export async function mfaSessionGuard(
  session: SessionGuardSession,
  context?: SessionGuardContext | null,
): Promise<boolean> {
  if (!context) {
    return true;
  }

  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { twoFactorEnabled: true },
  });

  if (!user?.twoFactorEnabled) {
    return true;
  }

  const path = context.path ?? '';
  if (sessionPathsAllowedWithTwoFactor.has(path)) {
    return true;
  }

  try {
    await recordAuditEvent({
      actorUserId: session.userId,
      action: 'MFA_SIGN_IN_REFUSED',
      targetType: 'user',
      targetId: session.userId,
      detail: { path },
    });
  } catch (error) {
    console.error('Failed to record a refused two-step sign-in', error);
  }

  return false;
}

/**
 * The agency a reset or verification link was rebuilt for, as the templates
 * take it: its name on one line, its look, and the support address that ends
 * the message (`passwordResetEmail` adds the "Questions?" line from it). Null
 * when the link stayed on our host, which keeps the message ours.
 */
function authEmailAgency(link: AuthLink): AuthEmailAgency | null {
  if (!link.agency) return null;
  return {
    name: oneLine(link.agency.workspaceName),
    brand: link.brand ?? null,
    supportEmail: link.supportEmail ?? null,
  };
}

/**
 * The two-step notices. The text is the notice with the fixed "If this was not
 * you" line under it, built by the template; the HTML adds a way to Account
 * security on our app.
 */
function securityEmail(to: string, subject: string, notice: string): void {
  queueAuthEmail({ to, ...securityNoticeEmail({ subject, notice, appUrl: env.APP_URL }) });
}

interface MfaHookSession {
  user: { id: string; email: string; twoFactorEnabled?: boolean };
  session: { token: string };
}

interface MfaHookContext {
  path?: string;
  context: {
    returned?: unknown;
    session?: MfaHookSession | null;
    newSession?: MfaHookSession | null;
  };
}

async function recordMfaAudit(input: {
  actorUserId: string;
  action:
    | 'MFA_ENABLED'
    | 'MFA_DISABLED'
    | 'MFA_BACKUP_CODE_USED'
    | 'MFA_BACKUP_CODES_REGENERATED';
  detail?: Record<string, unknown>;
}): Promise<void> {
  try {
    await recordAuditEvent({
      actorUserId: input.actorUserId,
      action: input.action,
      targetType: 'user',
      targetId: input.actorUserId,
      detail: input.detail,
    });
  } catch (error) {
    console.error(`Failed to record ${input.action}`, error);
  }
}

/**
 * Side effects for the two-factor endpoints.
 *
 * `ctx.context.returned` is only set after the endpoint answered without
 * throwing, so a wrong code or a wrong password never produces an audit row or
 * an email. The setup case is told apart from a sign-in verification by the
 * session that existed before the request: setup has one and flips
 * twoFactorEnabled from false to true; a sign-in verification has none.
 */
async function handleTwoFactorAfter(ctx: MfaHookContext): Promise<void> {
  // After hooks also run when the endpoint threw. An Error in `returned`
  // means the code or password was refused (or the endpoint failed), which
  // must not produce an email, an audit row, or a session revocation.
  if (!ctx.context.returned || ctx.context.returned instanceof Error) {
    return;
  }

  if (ctx.path === '/two-factor/verify-totp') {
    const before = ctx.context.session?.user;
    const after = ctx.context.newSession;
    if (!before || !after || before.twoFactorEnabled !== false || after.user.twoFactorEnabled !== true) {
      return;
    }

    // Sessions signed in with only a password predate the second factor. They
    // must not survive setup, or the workspace gate would keep accepting them.
    await prisma.session.deleteMany({
      where: { userId: after.user.id, token: { not: after.session.token } },
    });

    await recordMfaAudit({ actorUserId: after.user.id, action: 'MFA_ENABLED' });
    securityEmail(
      after.user.email,
      'Two-step verification was turned on',
      'Two-step verification was turned on for your DMARC Harbor account.',
    );
    return;
  }

  if (ctx.path === '/two-factor/disable') {
    const user = ctx.context.session?.user;
    if (!user) return;

    await recordMfaAudit({ actorUserId: user.id, action: 'MFA_DISABLED' });
    securityEmail(
      user.email,
      'Two-step verification was turned off',
      'Two-step verification was turned off for your DMARC Harbor account.',
    );
    return;
  }

  if (ctx.path === '/two-factor/verify-backup-code') {
    const user = ctx.context.newSession?.user ?? ctx.context.session?.user;
    if (!user) return;

    // Count, never return. The plugin also returns the codes it has left only
    // to a caller that asks for them; this email reports the number alone.
    let remaining: number | null = null;
    try {
      const viewed = await auth.api.viewBackupCodes({ body: { userId: user.id } });
      remaining = viewed.backupCodes.length;
    } catch {
      // The code was accepted either way; a missing count must not turn a
      // successful sign-in into a failure.
    }

    await recordMfaAudit({
      actorUserId: user.id,
      action: 'MFA_BACKUP_CODE_USED',
      ...(remaining === null ? {} : { detail: { remaining } }),
    });
    const count = remaining === null ? '' : ` ${remaining} left.`;
    const advice = remaining !== null && remaining <= 2 ? ' Generate new ones in Account security.' : '';
    securityEmail(user.email, 'A backup code was used to sign in', `A backup code was used to sign in.${count}${advice}`);
    return;
  }

  if (ctx.path === '/two-factor/generate-backup-codes') {
    const user = ctx.context.session?.user ?? ctx.context.newSession?.user;
    if (!user) return;

    await recordMfaAudit({ actorUserId: user.id, action: 'MFA_BACKUP_CODES_REGENERATED' });
    securityEmail(user.email, 'New backup codes were generated', 'New backup codes were generated; the old ones no longer work.');
  }
}

const socialProviders = socialProvidersFor(env);

/** The code on a Better Auth error that reached an after hook as `returned`, if it has one. */
function apiErrorCode(returned: unknown): string | null {
  if (!(returned instanceof Error)) return null;
  const code = (returned as { body?: { code?: unknown } }).body?.code;
  return typeof code === 'string' ? code : null;
}

type AuthHookContext = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0];

/**
 * Who a two-factor verification is for: the signed-in user while setting it
 * up, or, during sign-in, the user the two-factor challenge cookie names. The
 * same lookup the plugin makes (verify-two-factor.mjs), without consuming the
 * challenge.
 */
async function twoFactorUserId(ctx: AuthHookContext): Promise<string | null> {
  try {
    const session = await getSessionFromCtx(ctx);
    if (session?.user?.id) return session.user.id;
    const cookie = ctx.context.createAuthCookie('two_factor');
    const signed = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
    if (!signed) return null;
    const challenge = await ctx.context.internalAdapter.findVerificationValue(signed);
    return challenge?.value ?? null;
  } catch {
    return null;
  }
}

/**
 * Refuses a new password that appears in a known breach (password-breach.ts).
 * A password the service could not check is allowed: the length rule still
 * applies, and an outage there must not stop anyone getting into an account.
 */
async function assertPasswordNotBreached(password: unknown): Promise<void> {
  if (!env.PASSWORD_BREACH_CHECK || typeof password !== 'string' || password === '') {
    return;
  }
  const count = await passwordBreachCount(password);
  if (count !== null && count > 0) {
    throw new APIError('BAD_REQUEST', {
      code: 'PASSWORD_COMPROMISED',
      message: 'This password appears in known data breaches, so it is easy to guess. Choose a different one.',
    });
  }
}

const minutes = (ms: number) => Math.round(ms / 60_000);

/** True when a role string (possibly "a,b") includes owner. */
function hasOwnerRole(role: string | string[] | undefined | null): boolean {
  const roles = Array.isArray(role) ? role : String(role ?? '').split(',');
  return roles.some((value) => value.trim() === 'owner');
}

function ownershipMovesByTransfer(): APIError {
  return new APIError('FORBIDDEN', {
    code: 'OWNERSHIP_TRANSFER_REQUIRED',
    message: 'A workspace has one owner. To hand it to someone else, use Transfer ownership on the Members page.',
  });
}

/**
 * A wrong password for an address (sign-in-brake.ts). Counted for any address;
 * recorded and reported only when an account has it, so an address nobody
 * owns leaves nothing in the audit trail and sends no mail.
 */
async function onWrongPassword(email: string): Promise<void> {
  const failure = await recordSignInFailure(email);
  const user = await prisma.user
    .findUnique({ where: { email: email.trim().toLowerCase() }, select: { id: true, email: true } })
    .catch(() => null);
  if (!user) return;

  try {
    await recordAuditEvent({
      action: 'SIGN_IN_FAILED',
      outcome: 'DENIED',
      targetType: 'user',
      targetId: user.id,
      detail: { reason: 'wrong password', ...(failure ? { failures: failure.failures } : {}) },
    });
    if (failure?.pausedNow) {
      await recordAuditEvent({
        action: 'SIGN_IN_PAUSED',
        outcome: 'DENIED',
        targetType: 'user',
        targetId: user.id,
        detail: { failures: failure.failures, pauseMinutes: minutes(SIGN_IN_PAUSE_MS) },
      });
    }
  } catch (error) {
    console.error('Failed to record a failed sign-in', error);
  }

  if (failure?.pausedNow) {
    queueAuthEmail({
      to: user.email,
      ...signInPausedEmail({
        attempts: SIGN_IN_FAILURE_LIMIT,
        windowMinutes: minutes(SIGN_IN_FAILURE_WINDOW_MS),
        pauseMinutes: minutes(SIGN_IN_PAUSE_MS),
      }),
    });
  }
}

export const auth = betterAuth({
  appName: 'DMARC Harbor',
  baseURL: env.BETTER_AUTH_URL,
  secret: env.BETTER_AUTH_SECRET,
  database: prismaAdapter(prisma, { provider: 'postgresql' }),
  /**
   * Our web origins, plus the agency's own verified domain when a request came
   * through it, so a client can sign in where the agency sends them. The rule
   * for when an agency origin is trusted is in agency-origin.ts.
   */
  trustedOrigins: (request?: Request) => trustedOriginsFor(request),
  /**
   * Workspaces are created through POST /api/workspaces only.
   *
   * That route checks the plan's workspace allowance and records the DPA and
   * Terms acceptance in the same request. The plugin's own HTTP endpoint did
   * neither, so a direct call to /api/auth/organization/create made unlimited
   * workspaces with no acceptance on record. The server-side call our route
   * makes (auth.api.createOrganization) is not an HTTP request and still works.
   */
  /**
   * The plugin's own session revocations are switched off for the same kind of
   * reason: Account security uses /api/me/sessions, which records each
   * revocation in the audit log, and these three did the same thing with no
   * entry. Nothing in the app called them.
   */
  disabledPaths: ['/organization/create', '/revoke-session', '/revoke-sessions', '/revoke-other-sessions'],
  /**
   * Where a failed Google or Microsoft sign-in lands when Better Auth has no
   * error address of its own for it: a state that expired, was already used
   * (the browser's back button), or belongs to another browser. Without this
   * it rendered the library's own page on the API host ("Something went
   * wrong, CODE: state_mismatch") with no way back. The sign-in page reads the
   * `error` code and says what happened (apps/web/lib/sign-in-errors.ts).
   */
  onAPIError: {
    errorURL: `${env.APP_URL.replace(/\/+$/, '')}/sign-in`,
  },
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    maxPasswordLength: 128,
    autoSignIn: false,
    requireEmailVerification: true,
    revokeSessionsOnPasswordReset: true,
    resetPasswordTokenExpiresIn: 60 * 60,
    /**
     * After a reset link set a new password: the audit entry, the confirmation
     * to the owner, and the end of any sign-in pause, since whoever reset it
     * has just proved they hold the mailbox.
     */
    onPasswordReset: async ({ user }) => {
      await clearSignInFailures(user.email);
      try {
        await recordAuditEvent({
          actorUserId: user.id,
          action: 'PASSWORD_RESET',
          targetType: 'user',
          targetId: user.id,
          detail: { revokedSessions: true },
        });
      } catch (error) {
        console.error('Failed to record password reset audit event', error);
      }
      queueAuthEmail({ to: user.email, ...passwordChangedEmail({ via: 'reset' }) });
    },
    /**
     * A reset started on an agency's own domain is answered in the agency's
     * name, with the link on that domain (agency-auth-link.ts says when).
     * Everyone else gets the message as before.
     */
    sendResetPassword: async ({ user, url }) => {
      const link = await agencyAuthLink(url, user);
      queueAuthEmail({
        to: user.email,
        ...passwordResetEmail({ url: link.url, agency: authEmailAgency(link) }),
        ...(link.from ? { from: link.from } : {}),
        ...(link.replyTo ? { replyTo: link.replyTo } : {}),
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
     *
     * The message names no product, in the text or the HTML, because a client
     * on an agency's own domain can trigger it and should not learn whose
     * service runs underneath.
     */
    onExistingUserSignUp: async ({ user }) => {
      queueAuthEmail({ to: user.email, ...existingAccountSignUpEmail() });
    },
  },
  emailVerification: {
    sendOnSignUp: true,
    sendOnSignIn: true,
    autoSignInAfterVerification: true,
    expiresIn: 60 * 60 * 24,
    /** Same rule as the password reset: the agency's name and domain when it started there. */
    sendVerificationEmail: async ({ user, url }) => {
      const link = await agencyAuthLink(url, user);
      queueAuthEmail({
        to: user.email,
        ...emailVerificationEmail({ url: link.url, agency: authEmailAgency(link) }),
        ...(link.from ? { from: link.from } : {}),
        ...(link.replyTo ? { replyTo: link.replyTo } : {}),
      });
    },
  },
  socialProviders,
  session: {
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24,
    additionalFields: {
      authMethod: { type: 'string', required: false, input: false },
    },
  },
  databaseHooks: {
    session: {
      create: {
        before: (session, context) =>
          mfaSessionGuard(
            session as SessionGuardSession,
            context as SessionGuardContext | null | undefined,
          ),
      },
    },
  },
  advanced: {
    database: {
      joins: true,
    },
  },
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      /**
       * The per-account brake (sign-in-brake.ts): refused before the password
       * is checked, so a paused address answers the same whether or not the
       * password is right, and whether or not an account has it.
       */
      if (ctx.path === '/sign-in/email') {
        const email = (ctx.body as { email?: unknown } | undefined)?.email;
        if (typeof email === 'string' && email.trim() !== '') {
          const pause = await signInPause(email);
          if (pause.paused) {
            const wait = Math.max(1, Math.ceil(pause.retryAfterSeconds / 60));
            throw new APIError(
              'TOO_MANY_REQUESTS',
              {
                code: 'SIGN_IN_PAUSED',
                message: `Too many wrong passwords for this account, so password sign-in is paused for about ${wait} minute${wait === 1 ? '' : 's'}. Reset your password to get in now.`,
              },
              { 'Retry-After': String(pause.retryAfterSeconds) },
            );
          }
        }
        return;
      }

      if (ctx.path === '/sign-up/email') {
        await assertPasswordNotBreached((ctx.body as { password?: unknown } | undefined)?.password);
        return;
      }

      if (ctx.path === '/reset-password') {
        await assertPasswordNotBreached((ctx.body as { newPassword?: unknown } | undefined)?.newPassword);
        return;
      }

      if (ctx.path === '/two-factor/verify-totp' || ctx.path === '/two-factor/verify-backup-code') {
        const body = ctx.body as { trustDevice?: unknown; code?: unknown } | undefined;
        if (body && typeof body === 'object') {
          body.trustDevice = false;
        }

        // One use per code (totp-replay.ts). Claimed before the plugin checks
        // it, so two requests racing with the same code cannot both pass.
        const code = ctx.path === '/two-factor/verify-totp' ? claimableCode(body?.code) : null;
        if (code) {
          const userId = await twoFactorUserId(ctx);
          if (userId && !(await claimTotpCode(userId, code))) {
            throw new APIError('UNAUTHORIZED', {
              code: 'TOTP_CODE_REUSED',
              message: 'That code was already used. Wait for the next code in your authenticator app.',
            });
          }
        }
        return;
      }

      if (ctx.path === '/organization/update-member-role') {
        await rememberPreviousRole(ctx.body);
        return;
      }

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

      await assertPasswordNotBreached(body.newPassword);

      // Other devices are signed out unless the person unticked "Sign out my
      // other devices" on Account security, which sends an explicit false.
      body.revokeOtherSessions = body.revokeOtherSessions !== false;
    }),
    after: createAuthMiddleware(async (ctx) => {
      const returned = ctx.context.returned;

      if (ctx.path === '/sign-in/email') {
        const email = (ctx.body as { email?: unknown } | undefined)?.email;
        if (typeof email === 'string' && email.trim() !== '') {
          if (apiErrorCode(returned) === 'INVALID_EMAIL_OR_PASSWORD') {
            await onWrongPassword(email);
          } else if (returned && !(returned instanceof Error)) {
            // The password was right (a session, or the two-step challenge).
            await clearSignInFailures(email);
          }
        }
      }

      // A refused code frees its claim, so the right code typed next still works.
      if (ctx.path === '/two-factor/verify-totp' && returned instanceof Error && apiErrorCode(returned) !== 'TOTP_CODE_REUSED') {
        const code = claimableCode((ctx.body as { code?: unknown } | undefined)?.code);
        const userId = code ? await twoFactorUserId(ctx) : null;
        if (code && userId) {
          await releaseTotpCode(userId, code);
        }
      }

      if (ctx.path === '/change-password' && returned && !(returned instanceof Error)) {
        // Better Auth makes a new session only when it signs the others out;
        // keeping them, it leaves the current one, so the user comes from
        // whichever exists. Reading the new one alone lost the email and the
        // audit entry whenever "Sign out my other devices" was unticked.
        const rotated = ctx.context.newSession;
        const user = rotated?.user ?? ctx.context.session?.user;
        const signedOutOthers = (ctx.body as { revokeOtherSessions?: unknown } | undefined)?.revokeOtherSessions !== false;
        if (user?.id) {
          try {
            await recordAuditEvent({
              actorUserId: user.id,
              action: 'PASSWORD_CHANGED',
              targetType: 'user',
              targetId: user.id,
              detail: { revokedOtherSessions: signedOutOthers, sessionRotated: Boolean(rotated) },
            });
          } catch (error) {
            console.error('Failed to record password change audit event', error);
          }
          queueAuthEmail({ to: user.email, ...passwordChangedEmail({ via: 'change', signedOutOthers }) });
        }
      }

      if (ctx.path && membershipAuditPaths.has(ctx.path) && returned && !(returned instanceof Error)) {
        // The plugin's session middleware does not leave the session on the
        // context the after hook sees, so the actor is read from the request.
        const session = ctx.context.session ?? (await getSessionFromCtx(ctx).catch(() => null));
        const membershipCtx = { path: ctx.path, body: ctx.body, context: { returned, session } };
        await closeExpiredInvitationsReplacedBy(membershipCtx);
        await recordMembershipAudit(membershipCtx);
      }

      await handleTwoFactorAfter(ctx as unknown as MfaHookContext);
    }),
  },
  plugins: [
    organization({
      ac: accessControl,
      roles: organizationRoles,
      allowUserToCreateOrganization: () => true,
      requireEmailVerificationOnInvitation: true,
      /**
       * The plan's team size, enforced where people join.
       *
       * Published on every plan and never checked: the plugin's default of 100
       * applied everywhere, so a free workspace could hold a hundred members.
       * The limit applies when an invitation is accepted; the hook below refuses
       * the invitation itself, counting open ones, so nobody is invited into a
       * seat that does not exist.
       */
      /**
       * Workspaces are removed through the erasure request only.
       *
       * The plugin's /organization/delete deleted a workspace the moment an owner
       * called it: no seven-day grace period, no confirmation email, no audit
       * record that survives the workspace, and nothing that stops a paid
       * subscription billing for a workspace that no longer exists. The app never
       * called it, so switching it off removes a route and nothing else.
       */
      disableOrganizationDeletion: true,
      membershipLimit: async (_user, organization) => (await resolveEntitlements(organization.id)).maxMembers,
      organizationHooks: {
        /**
         * 402, like every other plan limit, not 403.
         *
         * It was FORBIDDEN, which read as "you may not invite people" rather
         * than "your plan is full": the one plan limit that did not answer
         * Payment Required, and the only one without the numbers and the plan
         * to move to beside the sentence. Better Auth's error takes any status
         * better-call knows, PAYMENT_REQUIRED included, and its body is written
         * flat ({ message, code, ...details }) rather than under `error`.
         *
         * Accepting an invitation after a downgrade is still refused by the
         * plugin's own membershipLimit check above, with its own 403: that
         * refusal reaches the invited person, who has no plan to upgrade.
         */
        beforeCreateInvitation: async ({ invitation, organization }) => {
          if (hasOwnerRole(invitation.role)) {
            throw ownershipMovesByTransfer();
          }
          const allowance = await memberAllowance(organization.id);
          if (allowance.members + allowance.pending >= allowance.limit) {
            throw new APIError('PAYMENT_REQUIRED', {
              message: memberLimitMessage(allowance),
              code: 'PLAN_LIMIT_REACHED',
              ...memberLimitDetails(allowance),
            });
          }
        },
        /**
         * Exactly one owner per workspace.
         *
         * The plan, the workspace allowance and the right to delete the
         * workspace all come from the owner's account, so a second owner made
         * each of them ambiguous, and the plugin let an owner make anyone an
         * owner. Ownership now moves only through the transfer
         * (ownership-transfer.service.ts), which demotes the old owner in the
         * same transaction. The owner's own role does not change here either.
         */
        beforeUpdateMemberRole: async ({ member, newRole }) => {
          if (hasOwnerRole(newRole) || hasOwnerRole(member.role)) {
            throw ownershipMovesByTransfer();
          }
        },
      },
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
    twoFactor({
      issuer: 'DMARC Harbor',
      totpOptions: { digits: 6, period: 30 },
      backupCodeOptions: { amount: 10, length: 10 },
    }),
  ],
});
