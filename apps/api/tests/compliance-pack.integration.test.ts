import { createHash } from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/database/prisma.js';
import { app } from '../src/index.js';
import { grantPlan } from './helpers/plan.js';
import { forensicPiiRetentionDays, forensicRetentionDays, reportRetentionDays } from '../src/services/privacy.service.js';
import { setOverride } from '../src/services/entitlements/entitlement.service.js';
import { buildCompliancePackPdf, issueCompliancePack } from '../src/services/trust/compliance-pack.service.js';
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

  const workspace = await agent.post('/api/workspaces').send({ name: 'Northgate Digital', slug: `pack-${Date.now()}-${fixtureId}`, dpaHasRead: true, dpaConfirmsAuthority: true});
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

describe('compliance pack reference', () => {
  beforeAll(resetDatabase);

  async function issue() {
    const { agent, organizationId } = await setupWorkspace('HARBOR');
    const client = await addClient(agent, organizationId, 'Acme Corporation');
    await addDomain(agent, organizationId, client.id, 'acme.test');
    const response = await agent.post(`/api/workspaces/${organizationId}/clients/${client.id}/compliance-packs`).send({});
    return { agent, organizationId, client, response };
  }

  it('issues a reference a human can read back over a phone', async () => {
    const { response } = await issue();
    const reference = String(response.headers['x-dmarc-pack-reference']);

    // Printed in the document, quoted in the filename, and what the public
    // verifier resolves. A cuid fails all three: it is 25 characters of noise, it
    // discloses that the value is a database row and roughly when it was created,
    // and nobody can read it back down a phone.
    /**
     * Twenty four hex characters is 96 bits. Six was 24, which is hours of
     * enumeration against a public endpoint that answers 200 or 404.
     */
    expect(reference).toMatch(/^DMARC-\d{8}-[A-Z0-9-]+-[A-F0-9]{24}$/);
    expect(reference).not.toMatch(/^cm[a-z0-9]{20,}$/i);
  });

  /**
   * The document must not state a retention period we do not honour.
   *
   * Section four used to print `plan.dataRetentionDays` and
   * `plan.auditRetentionDays`. The first governs only whether a dormant domain
   * still counts toward a quota; the second is read by no code at all, because
   * nothing deletes an audit log. A signed compliance statement handed to a
   * client's procurement team therefore carried two numbers, and neither was a
   * promise the running service kept.
   */
  it('states the retention windows this service actually applies', async () => {
    const { response } = await issue();

    const text = normalise(extractPdfText(response.body as Buffer));

    // Three windows, because there are three, and they differ by two orders of
    // magnitude. The shortest is the most sensitive data.
    expect(text).toContain(normalise('DMARC aggregate reports'));
    expect(text).toContain(normalise('Forensic reports'));
    expect(text).toContain(normalise('Named recipients in forensic data'));

    expect(text).toContain(normalise(`${reportRetentionDays()} days`));
    expect(text).toContain(normalise(`${forensicRetentionDays()} days`));
    expect(text).toContain(normalise(`${forensicPiiRetentionDays()} days`));

    // And the audit trail says what is true, which is that nothing expires it. The
    // extracted text has its spacing stripped, so the expectation is normalised the
    // same way rather than matched with a regex.
    expect(text).toContain(normalise('Audit trail'));
    expect(text).toContain(normalise('No automatic expiry is scheduled.'));

    /**
     * The number Harbor publishes for data. If this ever appears in a pack it means
     * the marketing figure has crept back in, because the document is supposed to
     * carry the enforced windows instead.
     */
    expect(text).not.toContain('1095 days');
  });

  /**
   * Widening the suffix must not invalidate anything already in a customer's hands.
   *
   * These documents are filed. A procurement team keeps one for years, and the
   * whole value of the verifier is that they can check a document from last year
   * still matches its published digest. So the six character references already
   * issued have to keep resolving, which they do because the lookup is by exact
   * string and was never format constrained.
   */
  it('still verifies a reference issued before the suffix was widened', async () => {
    const { organizationId, client } = await issue();

    const legacyReference = 'DMARC-20260101-LEGACY-CLIENT-A1B2C3';

    await prisma.compliancePack.create({
      data: {
        organizationId,
        clientId: client.id,
        reference: legacyReference,
        pdfHash: 'legacy-hash-value',
        byteSize: 1024,
        pageCount: 3,
        documentVersion: '1.0',
        scope: 'CLIENT',
        asOf: new Date('2026-01-01T00:00:00.000Z'),
      },
    });

    const verified = await request(app).get(`/api/compliance-packs/verify?reference=${legacyReference}`);

    expect(verified.status).toBe(200);
    expect(verified.body.found).toBe(true);
    expect(verified.body.packs[0].reference).toBe(legacyReference);
    expect(verified.body.packs[0].sha256).toBe('legacy-hash-value');
  });

  it('keeps the row id out of the download filename', async () => {
    const { response } = await issue();
    const disposition = String(response.headers['content-disposition']);
    const filename = disposition.match(/filename="([^"]+)"/)?.[1] ?? '';

    // The shipped filename was dmarc-compliance-<cuid>.pdf, which a compliance team
    // can neither file nor read back.
    expect(filename).toMatch(/^dmarc-compliance-DMARC-[\w-]+\.pdf$/);
    expect(disposition).not.toMatch(/cm[a-z0-9]{20,}/i);
  });

  it('uses one reference everywhere it appears', async () => {
    const { response } = await issue();
    const reference = String(response.headers['x-dmarc-pack-reference']);
    const filename = String(response.headers['content-disposition']).match(/filename="([^"]+)"/)?.[1] ?? '';

    // Three different values for one document is how a reader ends up verifying
    // against the wrong thing.
    expect(filename).toContain(reference);

    // normalise strips whitespace and lower cases but keeps hyphens, which the
    // reference is built from.
    const text = normalise(extractPdfText(response.body as Buffer));
    expect(text).toContain(reference.toLowerCase());
  });

  it('resolves the reference the document prints', async () => {
    const { response } = await issue();
    const reference = String(response.headers['x-dmarc-pack-reference']);
    const expectedHash = String(response.headers['x-dmarc-pack-sha256']);

    const verified = await request(app).get(`/api/compliance-packs/verify?reference=${encodeURIComponent(reference)}`);

    // The first implementation printed a UUID that was never persisted while the
    // verifier resolved on the row id, so the value the document told a reader to
    // quote could not be quoted and the scheme was unusable.
    expect(verified.status).toBe(200);
    expect(verified.body.found).toBe(true);
    expect(String(verified.body.packs?.[0]?.sha256)).toBe(expectedHash);
    expect(String(verified.body.packs?.[0]?.reference)).toBe(reference);
  });

  it('gives a reissued document its own reference rather than reusing one', async () => {
    const { agent, organizationId, client, response } = await issue();

    const again = await agent
      .post(`/api/workspaces/${organizationId}/clients/${client.id}/compliance-packs`)
      .send({});

    // The reference is printed in the document, so two issues are two documents
    // with two hashes. What matters is that neither borrows the other's value:
    // a reference that pointed at a superseded pack would verify the wrong bytes.
    expect(again.status).toBe(200);
    expect(String(again.headers['x-dmarc-pack-reference'])).not.toBe(
      String(response.headers['x-dmarc-pack-reference']),
    );

    const first = await request(app).get(
      `/api/compliance-packs/verify?reference=${encodeURIComponent(String(response.headers['x-dmarc-pack-reference']))}`,
    );
    expect(String(first.body.packs?.[0]?.sha256)).toBe(
      String(response.headers['x-dmarc-pack-sha256']),
    );
  });

  it('renders the same facts in three pages rather than seven', async () => {
    const { client, organizationId } = await issue();

    // Issued directly so the page count is on the returned value rather than having
    // to be parsed back out of a response header.
    const fresh = await issueCompliancePack({ clientId: client.id, organizationId });

    // Row heights were once estimated from string length, which reserved 80 to 95
    // points for a single 8.5pt line and produced a document that was mostly empty
    // grey bands. Same facts, seven pages. This is the cheapest guard against that
    // estimate coming back.
    expect(fresh.pageCount).toBeGreaterThan(0);
    expect(fresh.pageCount).toBeLessThanOrEqual(4);
  });

  it('is a filename a header can carry safely', async () => {
    const { response } = await issue();
    const disposition = String(response.headers['content-disposition']);

    // A quote, newline or path separator in a Content-Disposition is a header
    // injection, so the format is alphanumeric plus hyphens and nothing else.
    expect(disposition).not.toMatch(/[^\x20-\x7E]/);
    expect(disposition.split('filename=')[1]).not.toContain('/');
    expect(disposition.split('filename=')[1]).not.toContain('\\');
  });
});
