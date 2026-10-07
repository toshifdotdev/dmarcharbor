/**
 * webhooks-client.ts — browser-side mutations for the webhooks settings
 * section.
 *
 * It lives beside ops-client.ts rather than inside it because the webhook
 * endpoints are the one place where a mutation can hand back a credential: the
 * create response carries `secret` and nothing ever retrieves it again. Keeping
 * the calls here means the one-time secret has exactly one set of callers to be
 * careful about, and the file it lives in says so.
 *
 * Every call returns the same OpsResult discriminated union as ops-client.ts, so
 * a 402 still routes by its `feature` key instead of by matching a message.
 *
 * No entitlement gate is applied here on purpose. The webhook routes carry
 * `requireSession` and `requireOrganizationPermission('organization', 'update')`
 * only: there is no `requireFeature` on them, and no webhooks entitlement key
 * exists in the plan catalog. A gate the API does not enforce would be a promise
 * the backend cannot keep, so the section is shown to every workspace that can
 * reach it and the API owns the decision.
 */

import { opsCall, type OpsResult } from "./ops-client";
import type {
  RegisteredWebhook,
  WebhookDeliveryRow,
  WebhookEndpointRow,
  WebhookEventName,
} from "./types";

const wsPath = (orgId: string, tail: string) =>
  `/api/workspaces/${orgId}${tail}`;

/** POST /webhooks — registers an endpoint and returns the signing secret ONCE.
 *
 * The contract: name 2-80, url 1-500, events 1-4. `events` is optional and the
 * API substitutes its own default set when it is omitted, so it is only sent
 * when the form has a deliberate selection. The URL must be public https: the
 * API refuses anything else, and the error message it returns explains why.
 */
export const createWebhookEndpoint = (
  orgId: string,
  body: { name: string; url: string; events?: WebhookEventName[] },
): Promise<OpsResult<RegisteredWebhook>> =>
  opsCall<RegisteredWebhook>(wsPath(orgId, "/webhooks"), {
    method: "POST",
    body: JSON.stringify(body),
  });

/** PATCH /webhooks/:id — name, url, events and `active`.
 *
 * `active: false` pauses delivery. `active: true` clears the suspension too, so
 * this is also how a customer reconnects an endpoint that was auto-suspended
 * after too many failures.
 */
export const patchWebhookEndpoint = (
  orgId: string,
  endpointId: string,
  body: {
    name?: string;
    url?: string;
    events?: WebhookEventName[];
    active?: boolean;
  },
): Promise<OpsResult<WebhookEndpointRow>> =>
  opsCall<WebhookEndpointRow>(wsPath(orgId, `/webhooks/${endpointId}`), {
    method: "PATCH",
    body: JSON.stringify(body),
  });

/** DELETE /webhooks/:id — irreversible, and it takes the delivery history with
 *  the endpoint. 204, so there is no body to read. */
export const deleteWebhookEndpoint = (
  orgId: string,
  endpointId: string,
): Promise<OpsResult<void>> =>
  opsCall<void>(wsPath(orgId, `/webhooks/${endpointId}`), { method: "DELETE" });

/** POST /webhooks/test — queues one `domain.verified` test event for every
 *  active endpoint subscribed to it. `queued: 0` is a normal answer meaning
 *  nothing subscribes yet, and the API ships the wording to show. */
export const queueWebhookTest = (
  orgId: string,
): Promise<OpsResult<{ queued: number; notice: string }>> =>
  opsCall<{ queued: number; notice: string }>(wsPath(orgId, "/webhooks/test"), {
    method: "POST",
  });

/** POST /webhook-deliveries/:id/replay — requeues a delivery with the same
 *  payload and a fresh signature. The API accepts a replay for any delivery in
 *  the workspace, so the UI restricts it to the rows where resending is the
 *  point: FAILED, SUSPENDED, or anything that came back 4xx or 5xx. Replaying a
 *  row that already succeeded would send the customer a duplicate event they
 *  have already acted on. */
export const replayWebhookDelivery = (
  orgId: string,
  deliveryId: string,
): Promise<OpsResult<{ queued: boolean }>> =>
  opsCall<{ queued: boolean }>(
    wsPath(orgId, `/webhook-deliveries/${deliveryId}/replay`),
    { method: "POST" },
  );

/**
 * A delivery worth replaying.
 *
 * A row that was never attempted, or that succeeded, has nothing to fix. The
 * retry ladder already handles a delivery that is merely PENDING with a failed
 * attempt, so this is about the rows that will not move on their own: the ones
 * that used up their attempts, the ones an auto-suspension parked, and the ones
 * the receiver answered with an error status.
 */
export function canReplayWebhookDelivery(row: WebhookDeliveryRow): boolean {
  if (row.status === "DELIVERED") return false;
  if (row.status === "FAILED" || row.status === "SUSPENDED") return true;
  if (row.responseCode !== null && row.responseCode >= 400) return true;
  return row.attempts > 0 && row.lastError !== null;
}
