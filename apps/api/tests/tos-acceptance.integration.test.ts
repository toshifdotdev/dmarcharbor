import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/database/prisma.js';
import { app } from '../src/index.js';
import { tosAcceptanceFor } from '../src/services/dpa-acceptance.service.js';

/**
 * The Terms of Service is now a stored, enforced acceptance.
 *
 * It used to be a checkbox on the billing page and nothing else: no field on the
 * request, no check in the controller, no row anywhere. A customer on the free
 * plan therefore used the whole product having never accepted the document the
 * service is provided under, and a caller that ignored the UI reached the paid
 * path without it.
 */

let fixtureId = 0;
const password = 'correct-horse-battery-staple';

async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "audit_log", "idempotency_record", "api_key", "entitlement_override", "erasure_request", "subscription", "export_job", "notification", "report_digest", "report_share", "alert_delivery", "alert_event", "alert_recipient", "alert_rule", "notification_preference", "dmarc_forensic_report", "dmarc_auth_result", "dmarc_report_record", "dmarc_report", "scan", "domain", "client", "organization", invitation, member, session, account, verification, "user" CASCADE',
  );
}

async function signedInAgent(label: string) {
  fixtureId += 1;
  const email = `${label}-${Date.now()}-${fixtureId}@example.com`;
  expect((await request(app).post('/api/auth/sign-up/email').send({ name: 'Owner', email, password })).status).toBe(200);
  await prisma.user.update({ where: { email }, data: { emailVerified: true } });

  const agent = request.agent(app);
  expect((await agent.post('/api/auth/sign-in/email').send({ email, password })).status).toBe(200);
  return { agent, email };
}

describe('Terms of Service acceptance', () => {
  beforeAll(resetDatabase);

  it('refuses a workspace when the Terms box is not ticked', async () => {
    const { agent } = await signedInAgent('tos-missing');

    const response = await agent.post('/api/workspaces').send({
      name: 'No Terms',
      slug: `no-terms-${Date.now()}`,
      dpaHasRead: true,
      dpaConfirmsAuthority: true,
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('TERMS_NOT_ACCEPTED');
    // The client needs the document URL so it can show what is being accepted.
    expect(response.body.error.tosUrl).toBe('/terms');
    // And nothing was created: a refusal that leaves a workspace behind is not a refusal.
    const created = await prisma.organization.findFirst({ where: { slug: { startsWith: 'no-terms-' } } });
    expect(created).toBeNull();
  });

  it('records the acceptance on the workspace when it is ticked', async () => {
    const { agent, email } = await signedInAgent('tos-present');
    const slug = `with-terms-${Date.now()}`;

    const response = await agent.post('/api/workspaces').send({
      name: 'With Terms',
      slug,
      tosAccepted: true,
      dpaHasRead: true,
      dpaConfirmsAuthority: true,
    });

    expect(response.status).toBe(201);
    const organizationId = response.body.id as string;

    const acceptance = await tosAcceptanceFor(organizationId);
    expect(acceptance.accepted).toBe(true);
    expect(acceptance.version).toBe('1.0');
    expect(acceptance.acceptedByEmail).toBe(email);
    expect(acceptance.requiresReconsent).toBe(false);

    // And it is in the audit trail, which is the compliance evidence.
    const entry = await prisma.auditLog.findFirst({
      where: { organizationId, action: 'TERMS_ACCEPTED' },
    });
    expect(entry).not.toBeNull();
  });

  it('writes an audit trail entry naming the version', async () => {
    const { agent } = await signedInAgent('tos-audit');
    const created = await agent.post('/api/workspaces').send({
      name: 'Audit Trail',
      slug: `tos-audit-${Date.now()}`,
      tosAccepted: true,
      dpaHasRead: true,
      dpaConfirmsAuthority: true,
    });
    expect(created.status).toBe(201);
    const organizationId = created.body.id as string;

    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { organizationId, action: 'TERMS_ACCEPTED' },
    });
    const detail = entry.detail as { version?: string };
    expect(detail.version).toBe('1.0');
  });
});
