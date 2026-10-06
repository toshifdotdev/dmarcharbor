/**
 * seed-dev-user.ts - a signed-in-able workspace with data in it.
 *
 * Why this exists rather than "just sign up on the form": signing up locally is a
 * four-step process that most people give up on before they see the product. You have
 * to invent an email, invent a password, then find the verification link - which is
 * printed to the API terminal by the console email provider, and which since the
 * durable email queue landed appears on a 30 second tick rather than immediately. An
 * empty dashboard behind three gates is not a way to evaluate a product.
 *
 * So this creates the same account a real signup produces, in one command, and prints
 * the credentials.
 *
 * The account is created through Better Auth's own API rather than by writing a
 * `User` row directly. That is not ceremony: `Account.password` holds a hash produced
 * by Better Auth's scrypt parameters, and hand-writing a user row produces an account
 * that exists, appears in the member list, and cannot sign in. Using the library is the
 * only way to get the hash right without copying it out of the source.
 *
 * Email verification is then flipped, and the Data Processing Agreement acceptance is
 * recorded on the organisation. Both are normally gates, and both are exactly what a
 * seeded account has to have to be usable.
 *
 * REFUSES to run against anything that looks like production. This script writes a
 * known password to a real table; the only defence against running it against a
 * customer's database is a loud check before the first write.
 *
 *   npx tsx scripts/seed-dev-user.ts
 */

import { auth } from '../src/auth/auth.config.js';
import { prisma } from '../src/database/prisma.js';
import { env } from '../src/config/env.js';
import { setOrganizationPlan } from '../src/services/entitlements/entitlement.service.js';
import { recordDpaAcceptance } from '../src/services/dpa-acceptance.service.js';
import { domainSlug } from '../src/services/domain-slug.js';

const EMAIL = process.env.SEED_EMAIL ?? 'owner@dmarcharbor.test';
const PASSWORD = process.env.SEED_PASSWORD ?? 'Harbor-Dev-Password-2026';
const NAME = 'Dev Agency Owner';
const WORKSPACE = 'Harbor Dev Agency';

/**
 * Refuses anything that is not plainly a local database.
 *
 * Checked before the first write, not after. A script that discovers it is pointed at
 * production by printing a warning has already written the password.
 */
function assertLocalDatabase(): void {
  const url = process.env.DATABASE_URL ?? env.DATABASE_URL;

  const localish =
    /@(localhost|127\.0\.0\.1|host\.docker\.internal|\[::1\])(:\d+)?\//.test(url) ||
    /@(postgres|db|database)(:\d+)?\//.test(url);

  if (!localish) {
    throw new Error(
      `Refusing to seed: DATABASE_URL does not look like a local database.\n  ${url.replace(/:[^:@/]+@/, ':***@')}\n` +
        'This script writes a known password. Point it at a local database or set SEED_CONFIRM=yes to override deliberately.',
    );
  }

  if (process.env.SEED_CONFIRM === 'yes') {
    console.warn('[seed] SEED_CONFIRM=yes set, proceeding against a non-local-looking DATABASE_URL.');
  }

  if (env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed: NODE_ENV is production.');
  }
}

async function main(): Promise<void> {
  assertLocalDatabase();

  const existing = await prisma.user.findUnique({ where: { email: EMAIL }, select: { id: true } });

  if (existing) {
    console.log(`[seed] ${EMAIL} already exists. Remove it first, or set SEED_EMAIL to something else.`);
    await prisma.$disconnect();
    return;
  }

  /**
   * Through the library, so the password hash is one Better Auth will accept.
   *
   * `autoSignIn: false` in the auth config means this returns a user without a session,
   * which is fine: nothing here needs one.
   */
  const created = await auth.api.signUpEmail({ body: { name: NAME, email: EMAIL, password: PASSWORD } });
  const userId = created.user.id;

  // The gate a real person would click a link for.
  await prisma.user.update({ where: { id: userId }, data: { emailVerified: true } });

  const organization = await prisma.organization.create({
    data: {
      /**
       * Explicit, because Better Auth supplies this id itself in the real flow and
       * Prisma has no default for it. Anything readable will do: it is a cuid-shaped
       * column with no format requirement, and this makes re-running the script after
       * a partial failure predictable.
       */
      id: `org-seed-${Date.now()}`,
      name: WORKSPACE,
      slug: 'harbor-dev-agency',
      createdAt: new Date(),
    },
    select: { id: true },
  });

  await prisma.member.create({
    data: { id: `member-seed-${Date.now()}`, organizationId: organization.id, userId, role: 'owner', createdAt: new Date() },
  });

  /**
   * Recorded through the same service the API uses, so the seeded workspace is
   * indistinguishable from one created through the product. Writing `dpaAcceptedAt`
   * directly would work today and drift the moment that service grows a column.
   */
  await recordDpaAcceptance({
    organizationId: organization.id,
    actorUserId: userId,
    actorEmail: EMAIL,
    hasRead: true,
    confirmsAuthority: true,
    ipAddress: null,
  });

  // Admiralty so nothing is paywalled and every screen can be evaluated.
  await setOrganizationPlan(organization.id, 'ADMIRALTY');

  const client = await prisma.client.create({
    data: { organizationId: organization.id, name: 'Northwind Trading', slug: 'northwind-trading' },
    select: { id: true },
  });

  const domainName = 'northwind-trading.test';
  const domain = await prisma.domain.create({
    data: {
      clientId: client.id,
      name: domainName,
      slug: domainSlug(domainName),
      status: 'VERIFIED',
      verifiedAt: new Date(),
      score: 74,
      dmarcPolicy: 'quarantine',
      dmarcRecord: 'v=DMARC1; p=quarantine; rua=mailto:dmarc-reports@reports.dmarcharbor.com',
      collectForensicReports: true,
    },
    select: { id: true },
  });

  /**
   * One report, so the dashboard has a chart rather than an empty state.
   *
   * `recheckedAt` is left null on purpose: a domain with a null there is one the
   * re-verification scheduler will pick up, which is worth having on a dev machine.
   */
  await prisma.dmarcReport.create({
    data: {
      domainId: domain.id,
      reportType: 'AGGREGATE',
      fingerprint: `seed-${Date.now()}`,
      recordCount: 2,
      policyP: 'quarantine',
      retentionExpiresAt: new Date(Date.now() + 400 * 24 * 60 * 60 * 1000),
      receivedAt: new Date(Date.now() - 6 * 60 * 60 * 1000),
      records: {
        create: [
          {
            sourceIp: '10.0.0.1',
            messageCount: 14200,
            disposition: 'none',
            dkimResult: 'pass',
            spfResult: 'pass',
            headerFrom: 'northwind-trading.test',
          },
          {
            sourceIp: '45.83.12.9',
            messageCount: 310,
            disposition: 'quarantine',
            dkimResult: 'fail',
            spfResult: 'fail',
            headerFrom: 'northwind-trading.test',
          },
        ],
      },
    },
  });

  await prisma.alertRule.create({
    data: {
      organizationId: organization.id,
      domainId: domain.id,
      createdById: userId,
      name: 'Spoofing detected',
      metric: 'FAILURE_COUNT',
      operator: 'GREATER_THAN',
      threshold: 50,
      windowMinutes: 1440,
      cooldownMinutes: 1440,
    },
  });

  await prisma.$disconnect();

  console.log(`
[seed] done.

  Sign in at   http://localhost:3100/sign-in
  email        ${EMAIL}
  password     ${PASSWORD}

  Seeded: Admiralty workspace "${WORKSPACE}", 1 client, 1 verified domain
  (${domainName}), 1 aggregate report, 1 alert rule.

  The account is already email-verified and the DPA acceptance is recorded, so there
  is no confirmation email to go and find.
`);
}

main().catch(async (error: unknown) => {
  console.error('[seed] failed:', error instanceof Error ? error.message : error);
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});