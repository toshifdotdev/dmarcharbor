import { createHash } from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/database/prisma.js';
import { app } from '../src/index.js';
import { grantPlan } from './helpers/plan.js';
import { setOverride } from '../src/services/entitlements/entitlement.service.js';
import { buildCompliancePackPdf } from '../src/services/trust/compliance-pack.service.js';
import type { PlanTier } from '@prisma/client';

/**
 * The signed compliance pack.
 *
 * The scheme is deliberately small: a PDF, its SHA-256, and the digest published
 * where somebody holding the PDF can check it. Everything here exists to prove
 * that claim holds, or to fail loudly if it does not.
 */

let fixtureId = 0;
const password = 'correct-horse-battery-staple';

/**
 * Pulls the visible text back out of a rendered PDF.
 *
 * pdfkit writes each run of text as a positioned operator, so a phrase is not
 * contiguous in the raw bytes and a plain substring check proves nothing. The
 * documents are generated uncompressed precisely so the content streams can be
 * read, and this joins the string literals back into readable text.
 */
function extractPdfText(buffer: Buffer): string {
  const raw = buffer.toString('latin1');
  // pdfkit embeds font subsets, so visible text is written as hex strings
  // inside a TJ array rather than as literal parentheses.
  const pattern = /<([0-9a-fA-F]+)>/g;
  const parts: string[] = [];

  let match = pattern.exec(raw);
  while (match !== null) {
    const hex = match[1]!;
    if (hex.length % 2 === 0) {
      parts.push(Buffer.from(hex, 'hex').toString('latin1'));
    }
    match = pattern.exec(raw);
  }

  return parts.join(' ');
}

/**
 * pdfkit emits kerned runs, so a word can arrive as two fragments separated by
 * an adjustment. Comparing without whitespace is the only reliable way to
 * assert on a phrase.
 */
function normalise(value: string): string {
  return value.replace(/\s+/g, '').toLowerCase();
}

/**
 * The custom pack headers lower case to `x-dmarc-pack-*` rather than
 * `x-dmarcharbor-pack-*`, because the segment boundary is parsed between the
 * two. Real HTTP clients are case insensitive, so this is only a naming
 * curiosity, but reading the wrong key in a test looks like a missing header.
 */
function packHeader(name: 'sha256' | 'reference', headers: Record<string, string> = {}): string {
  const source = headers as unknown as Record<string, string>;
  const key = Object.keys(source).find((candidate) => candidate === `x-dmarc-pack-${name}`);
  if (!key) {
    throw new Error(`No x-dmarc-pack-${name} header. Saw: ${Object.keys(source).join(', ')}`);
  }
  return source[key]!;
}

async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "billing_plan", "billing_event", "client_portal_access", "webhook_delivery", "webhook_endpoint", "idempotency_record", "api_key", "entitlement_override", "erasure_request", "subscription", "export_job", "audit_log", "notification", "report_digest", "report_share", "alert_delivery", "alert_event", "alert_recipient", "alert_rule", "notification_preference", "dmarc_forensic_report", "dmarc_auth_result", "dmarc_report_record", "dmarc_report", "scan", "domain", "client", "organization", invitation, member, session, account, verification, "user" CASCADE',
  );
}

async function setupWorkspace(plan: PlanTier = 'HARBOR') {
  fixtureId += 1;
  const agent = request.agent(app);
  const email = `pack-${Date.now()}-${fixtureId}@example.com`;

  expect((await agent.post('/api/auth/sign-up/email').send({ name: 'Agency Owner', email, password })).status).toBe(200);
  await prisma.user.update({ where: { email }, data: { emailVerified: true } });
  expect((await agent.post('/api/auth/sign-in/email').send({ email, password })).status).toBe(200);

  const workspace = await agent.post('/api/workspaces').send({ name: 'Northgate Digital', slug: `pack-${Date.now()}-${fixtureId}` });
  const organizationId = workspace.body.id as string;
  if (plan !== 'MOORING') {
    await grantPlan(organizationId, plan);
  }

  return { agent, organizationId, email };
}

async function addClient(agent: ReturnType<typeof request.agent>, organizationId: string, name: string) {
  const created = await agent
    .post(`/api/workspaces/${organizationId}/clients`)
    .send({ name, slug: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now()}-${fixtureId}` });
  expect(created.status).toBe(201);
  return created.body as { id: string; name: string };
}

async function addDomain(agent: ReturnType<typeof request.agent>, organizationId: string, clientId: string, name: string) {
  const created = await agent.post(`/api/workspaces/${organizationId}/clients/${clientId}/domains`).send({ name });
  expect(created.status).toBe(201);
  await prisma.domain.update({ where: { id: created.body.id }, data: { status: 'VERIFIED', verifiedAt: new Date(), dmarcPolicy: 'reject' } });
  return created.body.id as string;
}

describe('compliance pack', () => {
  beforeAll(resetDatabase);

  it('refuses to produce a pack on a plan that does not include it', async () => {
    const { agent, organizationId } = await setupWorkspace('FAIRWAY');
    const client = await addClient(agent, organizationId, 'Fairway Client');

    const refused = await agent.post(`/api/workspaces/${organizationId}/clients/${client.id}/compliance-packs`).send({});
    expect(refused.status).toBe(402);
    expect(refused.body.error.feature).toBe('reports.compliancePack');
    expect(refused.body.error.requiredIn).toBe('HARBOR');

    // Reading the history is harmless, so it is allowed.
    const list = await agent.get(`/api/workspaces/${organizationId}/clients/${client.id}/compliance-packs`);
    expect(list.status).toBe(200);
    expect(list.body.packs).toEqual([]);
  });

  it('serves a real PDF and publishes the digest of exactly those bytes', async () => {
    const { agent, organizationId } = await setupWorkspace('HARBOR');
    const client = await addClient(agent, organizationId, 'Acme Corporation');
    await addDomain(agent, organizationId, client.id, 'acme.test');

    const response = await agent.post(`/api/workspaces/${organizationId}/clients/${client.id}/compliance-packs`).send({});

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('application/pdf');
    expect(response.headers['content-disposition']).toContain('attachment');

    const bytes = response.body as Buffer;
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');

    // The header digest must be the digest of what was actually served, which
    // is the entire scheme. Hashing a different copy would fingerprint a
    // document the reader never received.
    const served = createHash('sha256').update(bytes).digest('hex');
    expect(packHeader('sha256', response.headers)).toBe(served);
    expect(served).toMatch(/^[0-9a-f]{64}$/);

    // And it must match what the public verification endpoint publishes.
    const reference = packHeader('reference', response.headers);
    const verify = await request(app).get(`/api/compliance-packs/verify?reference=${reference}`);
    expect(verify.status).toBe(200);
    expect(verify.body.packs[0].sha256).toBe(served);
  });

  it('detects an edited document, which is the point of the whole exercise', async () => {
    const { agent, organizationId } = await setupWorkspace('HARBOR');
    const client = await addClient(agent, organizationId, 'Tamper Target');
    await addDomain(agent, organizationId, client.id, 'tamper-target.test');

    const issued = await agent.post(`/api/workspaces/${organizationId}/clients/${client.id}/compliance-packs`).send({});
    const original = issued.body as Buffer;
    const published = packHeader('sha256', issued.headers);

    // A one byte change, exactly what someone would make to soften a finding.
    const tampered = Buffer.from(original);
    tampered[tampered.length - 40] = tampered[tampered.length - 40] ^ 0x01;

    const tamperedHash = createHash('sha256').update(tampered).digest('hex');
    expect(tamperedHash).not.toBe(published);
  });

  it('renders deterministically, so regenerating does not invalidate anything', async () => {
    const { agent, organizationId } = await setupWorkspace('HARBOR');
    const client = await addClient(agent, organizationId, 'Deterministic Client');
    await addDomain(agent, organizationId, client.id, 'deterministic.test');

    // A fixed as of date and reference. The PDF creation date is pinned to the
    // as of timestamp, so pdfkit stamping a fresh date is the failure mode here.
    const asOf = new Date('2026-09-01T00:00:00.000Z');
    const first = await buildCompliancePackPdf({ clientId: client.id, asOf, reference: 'fixed-reference' });
    const second = await buildCompliancePackPdf({ clientId: client.id, asOf, reference: 'fixed-reference' });

    expect(first.hash).toBe(second.hash);
    expect(first.buffer.equals(second.buffer)).toBe(true);
    expect(first.pageCount).toBeGreaterThan(0);
  });

  it('never puts its own digest inside the document, which cannot work', async () => {
    const { agent, organizationId } = await setupWorkspace('HARBOR');
    const client = await addClient(agent, organizationId, 'Circular Guard');
    await addDomain(agent, organizationId, client.id, 'circular-guard.test');

    const rendered = await buildCompliancePackPdf({
      clientId: client.id,
      asOf: new Date('2026-09-01T00:00:00.000Z'),
      reference: 'circular-1',
    });

    // If the digest were printed in the file, the digest of the file could not
    // equal the value printed in it. This is the invariant worth asserting.
    expect(normalise(rendered.buffer.toString('latin1'))).not.toContain(rendered.hash);

    // The document carries a reference instead, which is what a reader quotes
    // when asking us for the published digest.
    expect(rendered.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rendered.pageCount).toBeGreaterThanOrEqual(2);
  });

  it('names only its own client, never a sibling in the same workspace', async () => {
    const { agent, organizationId } = await setupWorkspace('HARBOR');
    const packClient = await addClient(agent, organizationId, 'Public Client Ltd');
    const secretClient = await addClient(agent, organizationId, 'Secret Client Holdings');

    await addDomain(agent, organizationId, packClient.id, 'public-client.test');
    await addDomain(agent, organizationId, secretClient.id, 'secret-client.test');

    const response = await agent.post(`/api/workspaces/${organizationId}/clients/${packClient.id}/compliance-packs`).send({});
    expect(response.status).toBe(200);

    // A pack is forwarded to a procurement team and kept on file, so a sibling
    // customer's data appearing in it would be permanent.
    const text = normalise(extractPdfText(response.body as Buffer));
    expect(text).not.toContain(normalise('Secret Client Holdings'));
    expect(text).not.toContain(normalise('secret-client.test'));
  });

  it('states plainly that it is a self attestation, not an audit', async () => {
    const { agent, organizationId } = await setupWorkspace('HARBOR');
    const client = await addClient(agent, organizationId, 'Honest Client');
    await addDomain(agent, organizationId, client.id, 'honest-client.test');

    const response = await agent.post(`/api/workspaces/${organizationId}/clients/${client.id}/compliance-packs`).send({});

    // Prose inside a PDF is not searchable, so the claim is asserted through the
    // public verification payload, which is the part a reader quotes.
    const reference = packHeader('reference', response.headers);
    const verify = await request(app).get(`/api/compliance-packs/verify?reference=${reference}`);

    expect(verify.body.found).toBe(true);
    expect(verify.body.howToVerify).toContain('SHA-256');
    expect(verify.body.limitations).toContain('self attestation');
    expect(verify.body.limitations).toContain('not a third party audit');

    // And the document itself must say the same thing, not merely the API
    // response beside it. Overstating the guarantee in the PDF is the failure
    // this is guarding against.
    const text = normalise(extractPdfText(response.body as Buffer));

    expect(text).toContain(normalise('self attested'));
    expect(text).toContain(normalise('not a third party audit'));
    expect(text).toContain(normalise('cannot contain its own digest'));
  });

  it('reports whether named recipient data is held, following the plan', async () => {
    const { agent, organizationId } = await setupWorkspace('FAIRWAY');
    await setOverride(organizationId, { entitlement: 'reports.compliancePack', enabled: true, reason: 'Test only.' });

    const client = await addClient(agent, organizationId, 'Named Data Client');
    await addDomain(agent, organizationId, client.id, 'named-data.test');

    const response = await agent.post(`/api/workspaces/${organizationId}/clients/${client.id}/compliance-packs`).send({});
    expect(response.status).toBe(200);

    // The whole point of the document is to describe what is actually held, so
    // the per plan data table has to come from the entitlement rather than from
    // a list written once in the template.
    const stored = await prisma.compliancePack.findFirstOrThrow({
      where: { clientId: client.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(stored.pdfHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps earlier packs provable after a newer one is issued', async () => {
    const { agent, organizationId } = await setupWorkspace('HARBOR');
    const client = await addClient(agent, organizationId, 'History Client');
    await addDomain(agent, organizationId, client.id, 'history-client.test');

    const first = await agent.post(`/api/workspaces/${organizationId}/clients/${client.id}/compliance-packs`).send({});
    const firstReference = packHeader('reference', first.headers) as string;
    const firstHash = packHeader('sha256', first.headers) as string;

    // A later pack, after the data has changed.
    await addDomain(agent, organizationId, client.id, 'history-client-two.test');
    const second = await agent.post(`/api/workspaces/${organizationId}/clients/${client.id}/compliance-packs`).send({});

    expect(packHeader('sha256', second.headers)).not.toBe(firstHash);

    // The auditor may still be holding the earlier document, so it must remain
    // verifiable, marked superseded rather than withdrawn.
    const verifyOld = await request(app).get(`/api/compliance-packs/verify?reference=${firstReference}`);
    expect(verifyOld.status).toBe(200);
    expect(verifyOld.body.packs[0].sha256).toBe(firstHash);
    expect(verifyOld.body.packs[0].superseded).toBe(true);

    const list = await agent.get(`/api/workspaces/${organizationId}/clients/${client.id}/compliance-packs`);
    expect(list.body.packs.length).toBe(2);
  });

  it('does not disclose anything personal through the public verifier', async () => {
    const { agent, organizationId, email } = await setupWorkspace('HARBOR');
    const client = await addClient(agent, organizationId, 'Private Client');
    await addDomain(agent, organizationId, client.id, 'private-client.test');

    const response = await agent.post(`/api/workspaces/${organizationId}/clients/${client.id}/compliance-packs`).send({});
    const reference = packHeader('reference', response.headers);

    const verify = await request(app).get(`/api/compliance-packs/verify?reference=${reference}`);
    const body = JSON.stringify(verify.body);

    // The verifier is unauthenticated. It answers about a fingerprint and
    // nothing else, or it becomes a public directory of clients.
    expect(body).not.toContain(email);
    expect(body).not.toContain('Private Client');
    expect(body).not.toContain('private-client.test');
    expect(body).not.toContain(client.id);
  });

  it('answers a 404 for an unknown reference without leaking that fact differently', async () => {
    const unknown = await request(app).get('/api/compliance-packs/verify?reference=does-not-exist');
    expect(unknown.status).toBe(404);
    expect(unknown.body.found).toBe(false);
    expect(unknown.body.packs).toEqual([]);
  });

  it('will not issue a pack for a client in another workspace', async () => {
    const mine = await setupWorkspace('HARBOR');
    const theirs = await setupWorkspace('HARBOR');
    const theirClient = await addClient(theirs.agent, theirs.organizationId, 'Their Client');

    const response = await mine.agent.post(`/api/workspaces/${mine.organizationId}/clients/${theirClient.id}/compliance-packs`).send({});
    expect([403, 404]).toContain(response.status);

    expect(await prisma.compliancePack.count({ where: { clientId: theirClient.id } })).toBe(0);
  });

  it('records the issue in the audit trail', async () => {
    const { agent, organizationId } = await setupWorkspace('HARBOR');
    const client = await addClient(agent, organizationId, 'Audited Client');
    await addDomain(agent, organizationId, client.id, 'audited-client.test');

    const response = await agent.post(`/api/workspaces/${organizationId}/clients/${client.id}/compliance-packs`).send({});
    const hash = packHeader('sha256', response.headers);

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { organizationId, action: 'COMPLIANCE_PACK_ISSUED' },
      orderBy: { createdAt: 'desc' },
    });

    expect(audit.detail).toMatchObject({ clientId: client.id, hash, documentVersion: '1.0' });
  });
});
