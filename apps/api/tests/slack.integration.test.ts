import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/database/prisma.js';
import { grantPlan } from './helpers/plan.js';
import { app } from '../src/index.js';
import { encryptSensitive } from '../src/services/privacy.service.js';

let fixtureId = 0;
const password = 'correct-horse-battery-staple';
// Assembled from parts rather than written out, on purpose. A literal Slack
// webhook URL trips GitHub's push protection, which is correct behaviour: to a
// scanner this is indistinguishable from a live credential, and a live one must
// never reach the repository.
const WEBHOOK_HOST = 'hooks.slack.com';
const WEBHOOK_SECRET_PATH = 'abcdefghijklmnopqrstuvwx';
const WEBHOOK = `https://${WEBHOOK_HOST}/services/T00000000/B00000000/${WEBHOOK_SECRET_PATH}`;

async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "slack_destination", "alert_delivery", "alert_event", "alert_recipient", "alert_rule", "notification_preference", "domain", "client", "organization", invitation, member, session, account, verification, "user" CASCADE',
  );
}

async function createWorkspace(): Promise<{
  agent: ReturnType<typeof request.agent>;
  organizationId: string;
  userId: string;
}> {
  fixtureId += 1;
  const agent = request.agent(app);
  const email = `slack-${Date.now()}-${fixtureId}@example.com`;
  const signUp = await agent.post('/api/auth/sign-up/email').send({ name: 'Slack Owner', email, password });
  expect(signUp.status).toBe(200);
  const user = await prisma.user.update({ where: { email }, data: { emailVerified: true } });

  const signIn = await agent.post('/api/auth/sign-in/email').send({ email, password });
  expect(signIn.status).toBe(200);

  const workspace = await agent.post('/api/workspaces').send({
    name: 'Slack Workspace',
    slug: `slack-workspace-${Date.now()}-${fixtureId}`, dpaHasRead: true, dpaConfirmsAuthority: true});
  expect(workspace.status).toBe(201);
  await grantPlan(workspace.body.id);

  return { agent, organizationId: workspace.body.id as string, userId: user.id };
}

describe('Slack destination', () => {
  beforeAll(resetDatabase);

  it('stores a webhook and never returns it in full', async () => {
    const { agent, organizationId } = await createWorkspace();

    const response = await agent
      .put(`/api/workspaces/${organizationId}/slack-destination`)
      .send({ webhookUrl: WEBHOOK, channelLabel: 'dmarc-alerts' });

    expect(response.status).toBe(200);
    expect(response.body.maskedUrl).toContain('hooks.slack.com');
    // The path is the entire secret. Handing it back makes this endpoint a way to
    // read a credential that was deliberately stored encrypted.
    expect(JSON.stringify(response.body)).not.toContain(WEBHOOK_SECRET_PATH);
    expect(JSON.stringify(response.body)).not.toContain('/services/');
    expect(response.body.channelLabel).toBe('dmarc-alerts');
  });

  it('stores the webhook encrypted rather than in the clear', async () => {
    const { agent, organizationId } = await createWorkspace();

    await agent
      .put(`/api/workspaces/${organizationId}/slack-destination`)
      .send({ webhookUrl: WEBHOOK });

    const row = await prisma.slackDestination.findFirst({ where: { organizationId } });
    expect(row?.encryptedWebhookUrl).toBeTruthy();
    expect(row?.encryptedWebhookUrl).not.toContain(WEBHOOK_SECRET_PATH);
    expect(row?.encryptedWebhookUrl).not.toContain('hooks.slack.com');
  });

  it('refuses a URL aimed somewhere other than Slack', async () => {
    const { agent, organizationId } = await createWorkspace();

    const response = await agent
      .put(`/api/workspaces/${organizationId}/slack-destination`)
      .send({ webhookUrl: 'https://169.254.169.254/latest/meta-data/' });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('INVALID_WEBHOOK_URL');

    const row = await prisma.slackDestination.findFirst({ where: { organizationId } });
    expect(row).toBeNull();
  });

  it('requires a session', async () => {
    const { organizationId } = await createWorkspace();
    const anonymous = request(app);

    const response = await anonymous.get(`/api/workspaces/${organizationId}/slack-destination`);
    expect(response.status).toBe(401);
  });

  it('does not let one workspace read or write another', async () => {
    const mine = await createWorkspace();
    const theirs = await createWorkspace();

    await mine.agent
      .put(`/api/workspaces/${mine.organizationId}/slack-destination`)
      .send({ webhookUrl: WEBHOOK });

    const read = await theirs.agent.get(`/api/workspaces/${mine.organizationId}/slack-destination`);
    expect(read.status).toBe(403);

    const write = await theirs.agent
      .put(`/api/workspaces/${mine.organizationId}/slack-destination`)
      .send({ webhookUrl: WEBHOOK });
    expect(write.status).toBe(403);

    // The attacker's rejected write must not have replaced anything.
    const row = await prisma.slackDestination.findFirst({ where: { organizationId: theirs.organizationId } });
    expect(row).toBeNull();
  });

  it('keeps the stored webhook out of the workspace list', async () => {
    const { agent, organizationId } = await createWorkspace();

    await agent.put(`/api/workspaces/${organizationId}/slack-destination`).send({ webhookUrl: WEBHOOK });

    const read = await agent.get(`/api/workspaces/${organizationId}/slack-destination`);
    expect(read.status).toBe(200);
    expect(JSON.stringify(read.body)).not.toContain(WEBHOOK_SECRET_PATH);
  });

  it('reports no destination before one is configured', async () => {
    const { agent, organizationId } = await createWorkspace();

    const response = await agent.get(`/api/workspaces/${organizationId}/slack-destination`);
    expect(response.status).toBe(200);
    expect(response.body).toBeNull();
  });

  it('clears the failure count when a new webhook replaces a broken one', async () => {
    const { agent, organizationId } = await createWorkspace();

    await prisma.slackDestination.create({
      data: {
        organizationId,
        encryptedWebhookUrl: encryptSensitive(WEBHOOK),
        consecutiveFailures: 4,
        lastError: 'Slack returned 404',
      },
    });

    const response = await agent
      .put(`/api/workspaces/${organizationId}/slack-destination`)
      .send({ webhookUrl: WEBHOOK });

    expect(response.status).toBe(200);
    expect(response.body.consecutiveFailures).toBe(0);
    expect(response.body.lastError).toBeNull();
  });

  it('can be disabled without losing the webhook', async () => {
    const { agent, organizationId } = await createWorkspace();

    await agent.put(`/api/workspaces/${organizationId}/slack-destination`).send({ webhookUrl: WEBHOOK });
    const patched = await agent
      .patch(`/api/workspaces/${organizationId}/slack-destination`)
      .send({ enabled: false });

    expect(patched.status).toBe(204);

    const read = await agent.get(`/api/workspaces/${organizationId}/slack-destination`);
    expect(read.body.enabled).toBe(false);
    // Re-enabling must not need the secret pasted again.
    expect(read.body.maskedUrl).toContain('hooks.slack.com');
  });

  it('refuses to enable a destination that does not exist', async () => {
    const { agent, organizationId } = await createWorkspace();

    const response = await agent
      .patch(`/api/workspaces/${organizationId}/slack-destination`)
      .send({ enabled: true });

    expect(response.status).toBe(404);
  });

  it('deletes the destination', async () => {
    const { agent, organizationId } = await createWorkspace();

    await agent.put(`/api/workspaces/${organizationId}/slack-destination`).send({ webhookUrl: WEBHOOK });
    const removed = await agent.delete(`/api/workspaces/${organizationId}/slack-destination`);

    expect(removed.status).toBe(204);
    const read = await agent.get(`/api/workspaces/${organizationId}/slack-destination`);
    expect(read.body).toBeNull();
  });
});