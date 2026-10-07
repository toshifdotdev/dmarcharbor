"use client";

/**
 * webhooks-client.tsx — outbound webhooks: endpoints, and the delivery log.
 *
 * Four things this screen has to get right, all of them from the backend
 * contract rather than from taste:
 *
 * 1. THE SIGNING SECRET IS SHOWN ONCE. The create response carries it and
 *    nothing retrieves it again, so it gets its own panel above everything else
 *    with no dismiss-anywhere-else. Dismissing it destroys the copy. The API
 *    stores the secret encrypted, not hashed, so the platform can still sign:
 *    which means it is not recoverable through any endpoint either.
 * 2. AN EMPTY LIST IS NOT A FAILURE. No endpoints and no deliveries are both
 *    normal first-run states, and each says what to do next. A failed load
 *    renders as failure, never as empty, because an integration quietly missing
 *    is how a customer finds out their alerting broke from their own customers.
 * 3. REPLAY IS FOR ROWS THAT FAILED. The API accepts a replay for any delivery
 *    in the workspace; replaying one that already succeeded would send a
 *    duplicate event the customer has already acted on, so the button appears
 *    only where resending is the point.
 * 4. THE URL MUST BE PUBLIC HTTPS. The form checks the shape before the round
 *    trip so the refusal is immediate, and quotes the API's own reason rather
 *    than inventing one.
 *
 * The endpoint URL is shown in full because it is not a credential the way a
 * Slack webhook URL is: it is the address we post to. The SECRET is the
 * credential, and it is not on screen after the create panel closes.
 */

import { ActionButton } from "@/components/action-button";
import { ConfirmAction } from "@/components/confirm-action";
import { EmptyState, ErrorState } from "@/components/data-states";
import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  canReplayWebhookDelivery,
  createWebhookEndpoint,
  deleteWebhookEndpoint,
  patchWebhookEndpoint,
  queueWebhookTest,
  replayWebhookDelivery,
} from "@/lib/webhooks-client";
import type {
  ApiErrorBody,
  RegisteredWebhook,
  WebhookDeliveryRow,
  WebhookEndpointRow,
  WebhookEventName,
} from "@/lib/types";

/** Plain-language explanation per event, because `domain.verified` on its own
 *  tells an integrator nothing about when it fires. */
const EVENT_LABELS: Record<WebhookEventName, string> = {
  "domain.verified": "Domain verified: DNS ownership of a domain was confirmed.",
  "alert.triggered": "Alert triggered: an alert rule you configured fired.",
  "report.received": "Report received: a DMARC report arrived. Opt in, because a large agency gets hundreds a day.",
  "entitlement.exceeded": "Plan limit reached: a request was refused because a client, domain or member limit was hit.",
};

const STATUS_TONE: Record<WebhookDeliveryRow["status"], string> = {
  DELIVERED: "var(--color-pass)",
  PENDING: "var(--color-unmeasured)",
  IN_FLIGHT: "var(--color-unmeasured)",
  FAILED: "var(--color-block)",
  SUSPENDED: "var(--color-unverified)",
};

export function WebhooksPanel({
  organizationId,
  endpoints,
  events,
  defaultEvents,
  deliveries,
  endpointsFailed,
  deliveriesFailed,
}: {
  organizationId: string;
  endpoints: WebhookEndpointRow[];
  /** The event catalogue as the API published it. Never hardcoded here: the API
   *  is the authority on which events exist and the create form would 400 on
   *  anything it does not accept. */
  events: WebhookEventName[];
  defaultEvents: WebhookEventName[];
  deliveries: WebhookDeliveryRow[];
  endpointsFailed: boolean;
  deliveriesFailed: boolean;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [selected, setSelected] = useState<WebhookEventName[]>(defaultEvents);
  const [issued, setIssued] = useState<RegisteredWebhook | null>(null);
  const [error, setError] = useState<ApiErrorBody["error"] | null>(null);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testNote, setTestNote] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  // The API caps events at four and requires at least one. Both are enforced
  // here too so the form cannot submit something the API will refuse.
  const urlLooksPublicHttps = /^https:\/\/[^\s/$.?#][^\s]*$/i.test(url.trim());
  const canSubmit =
    name.trim().length >= 2 &&
    name.trim().length <= 80 &&
    url.trim().length >= 1 &&
    url.trim().length <= 500 &&
    urlLooksPublicHttps &&
    selected.length >= 1 &&
    selected.length <= 4;

  function toggleEvent(event: WebhookEventName) {
    setSelected((prev) =>
      prev.includes(event) ? prev.filter((e) => e !== event) : [...prev, event],
    );
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    const res = await createWebhookEndpoint(organizationId, {
      name: name.trim(),
      url: url.trim(),
      events: selected,
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setName("");
    setUrl("");
    setSelected(defaultEvents);
    // The only moment this secret exists in the browser.
    setIssued(res.data);
    router.refresh();
  }

  async function sendTest() {
    setTesting(true);
    setTestNote(null);
    const res = await queueWebhookTest(organizationId);
    setTesting(false);
    if (!res.ok) {
      setTestNote(res.error.message ?? "The test delivery could not be queued.");
      return;
    }
    // The API owns the wording, including "nothing subscribes yet", which is a
    // normal answer rather than a failure.
    setTestNote(res.data.notice);
    router.refresh();
  }

  const endpointsById = new Map(endpoints.map((e) => [e.id, e]));

  return (
    <div className="flex flex-col gap-5">
      {/* The one-time secret. This panel is the only place it will ever appear. */}
      {issued ? (
        <div
          role="alert"
          data-testid="webhook-secret"
          className="rounded-[2px] border px-5 py-4"
          style={{
            borderColor: "var(--color-accent)",
            background: "var(--color-accent-soft)",
          }}
        >
          <p
            className="num text-[11px] font-semibold tracking-[0.12em] uppercase"
            style={{ color: "var(--color-ink)" }}
          >
            Copy this signing secret now: it is shown once
          </p>
          <p
            className="num mt-2.5 break-all rounded-[2px] border px-3 py-2.5 text-[12.5px]"
            style={{
              background: "var(--color-elevate)",
              borderColor: "var(--color-line-strong)",
              color: "var(--color-ink)",
            }}
          >
            {issued.secret}
          </p>
          <p className="mt-2.5 text-[12.5px]" style={{ color: "var(--color-ink-2)" }}>
            This secret cannot be read again. It is stored encrypted so that we can
            keep signing, and no endpoint of this API returns it: your receiver
            recomputes the HMAC over the{" "}
            <span className="num">x-dmarcharbor-timestamp</span> and the raw body,
            and compares it to{" "}
            <span className="num">x-dmarcharbor-signature</span>. If you lose it,
            delete the endpoint and register a new one. Signed events to{" "}
            <span className="num">{issued.name}</span>:{" "}
            <span className="num">{issued.events.join(", ")}</span>.
          </p>
          <ActionButton
            label="Dismiss"
            busy={false}
            onClick={() => setIssued(null)}
            variant="ghost"
            testId="webhook-secret-dismiss"
            style={{ marginTop: 12 }}
          />
        </div>
      ) : null}

      <section
        className="lift rounded-[2px] border p-5"
        style={{ background: "var(--color-surface)", borderColor: "var(--color-line)" }}
      >
        <h2 className="text-[16px] font-semibold tracking-[-0.012em]">
          Add an endpoint
        </h2>
        <p className="mt-2 text-[13px]" style={{ color: "var(--color-ink-2)" }}>
          We POST a signed JSON event to a public{" "}
          <span className="num">https</span> address you control. Each payload
          names the event and carries identifiers; fetch the detail from the read
          API if you want it, so a high volume feed stays small.
        </p>

        {error ? (
          <p role="alert" className="mt-3 text-[14px]" style={{ color: "var(--color-block)" }}>
            {error.message}
          </p>
        ) : null}

        <form onSubmit={create} className="mt-4 flex flex-col gap-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5">
              <span className="label">Name</span>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="HaloPSA"
                required
                minLength={2}
                maxLength={80}
                data-testid="webhook-name"
                style={INPUT_STYLE}
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="label">Endpoint URL</span>
              <input
                type="text"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://hooks.example.com/dmarc"
                required
                maxLength={500}
                inputMode="url"
                spellCheck={false}
                data-testid="webhook-url"
                style={INPUT_STYLE}
              />
            </label>
          </div>

          {url.trim().length > 0 && !urlLooksPublicHttps ? (
            <p role="status" className="text-[13px]" style={{ color: "var(--color-unverified)" }}>
              The endpoint must be a public <span className="num">https</span>{" "}
              address. Plain <span className="num">http</span> is refused, because
              the payload carries a signed event, and a local or private address is
              refused because we could not reach it from outside our network.
            </p>
          ) : null}

          <fieldset className="flex flex-col gap-2">
            <legend className="label">Events to send</legend>
            <div className="flex flex-col gap-1.5">
              {events.map((event) => (
                <label
                  key={event}
                  className="flex items-start gap-2.5 text-[13px]"
                  style={{ color: "var(--color-ink-2)" }}
                >
                  <input
                    type="checkbox"
                    checked={selected.includes(event)}
                    onChange={() => toggleEvent(event)}
                    data-testid={`webhook-event-${event}`}
                    style={{ marginTop: 3 }}
                  />
                  <span>
                    <span className="num" style={{ color: "var(--color-ink)" }}>
                      {event}
                    </span>{" "}
                    <span style={{ color: "var(--color-ink-3)" }}>
                      {EVENT_LABELS[event]}
                    </span>
                  </span>
                </label>
              ))}
            </div>
            {selected.length === 0 ? (
              <p role="status" className="text-[13px]" style={{ color: "var(--color-unverified)" }}>
                Pick at least one event. An endpoint subscribed to nothing is
                never sent anything, which looks identical to a broken one.
              </p>
            ) : null}
          </fieldset>

          <ActionButton
            label="Add endpoint"
            loadingLabel="Adding…"
            busy={busy}
            disabled={!canSubmit}
            type="submit"
            testId="webhook-create"
            style={{ alignSelf: "flex-start" }}
          />
        </form>
      </section>

      {endpointsFailed ? (
        <ErrorState
          what="the webhook endpoints"
          detail="This list is every address this workspace posts events to. An empty list here would read as no integrations, which is a different claim from not being able to look."
        />
      ) : endpoints.length === 0 ? (
        <EmptyState
          title="No endpoints yet"
          description="An endpoint is a public https address we post signed events to, such as a ticketing or PSA system. Add the first one above: the signing secret is shown once at creation, so keep it where your integration can read it."
        />
      ) : (
        <section
          className="lift rounded-[2px] border p-5"
          style={{ background: "var(--color-surface)", borderColor: "var(--color-line)" }}
        >
          <h2 className="text-[16px] font-semibold tracking-[-0.012em]">Endpoints</h2>

          <ul className="mt-4 flex flex-col">
            {endpoints.map((endpoint) => (
              <EndpointRow
                key={endpoint.id}
                organizationId={organizationId}
                endpoint={endpoint}
                events={events}
                editing={editingId === endpoint.id}
                onEdit={() =>
                  setEditingId((prev) => (prev === endpoint.id ? null : endpoint.id))
                }
                onEdited={() => setEditingId(null)}
              />
            ))}
          </ul>
        </section>
      )}

      <section
        className="lift rounded-[2px] border p-5"
        style={{ background: "var(--color-surface)", borderColor: "var(--color-line)" }}
      >
        <h2 className="text-[16px] font-semibold tracking-[-0.012em]">
          Send a test delivery
        </h2>
        <p className="mt-2 text-[13px]" style={{ color: "var(--color-ink-2)" }}>
          Queues one <span className="num">domain.verified</span> event for every
          active endpoint subscribed to it, so you can confirm the address and the
          signature handling without waiting for real traffic. It goes through the
          same queue and the same retries as a real event.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <ActionButton
            label="Queue a test delivery"
            loadingLabel="Queuing…"
            busy={testing}
            onClick={sendTest}
            variant="ghost"
            testId="webhook-test"
          />
          {testNote ? (
            <p role="status" className="text-[13px]" style={{ color: "var(--color-ink-2)" }}>
              {testNote}
            </p>
          ) : null}
        </div>
        {endpoints.length === 0 && !endpointsFailed ? (
          <p className="mt-3 text-[12.5px]" style={{ color: "var(--color-ink-3)" }}>
            With no endpoint subscribed yet there is nothing to queue: add an
            endpoint above and this sends to it.
          </p>
        ) : null}
      </section>

      {deliveriesFailed ? (
        <ErrorState
          what="the webhook delivery log"
          detail="The log is how a broken integration gets found before the customer reports it. An empty log here would look like no events were ever sent, which is a different claim."
        />
      ) : deliveries.length === 0 ? (
        <EmptyState
          title="Nothing has been delivered yet"
          description="Every event we try to send is recorded here, with its status, attempt count and the response your endpoint gave. Send a test delivery above to create the first row."
        />
      ) : (
        <section
          className="lift rounded-[2px] border p-5"
          style={{ background: "var(--color-surface)", borderColor: "var(--color-line)" }}
        >
          <h2 className="text-[16px] font-semibold tracking-[-0.012em]">
            Delivery log
          </h2>
          <p className="mt-2 text-[13px]" style={{ color: "var(--color-ink-2)" }}>
            The most recent attempts across every endpoint, newest first. A
            failed delivery is retried with backoff; once it has used its
            attempts it waits here until you replay it or a later repair sweep
            requeues it.
          </p>
          <ul className="mt-4 flex flex-col">
            {deliveries.map((delivery) => (
              <DeliveryRow
                key={delivery.id}
                organizationId={organizationId}
                delivery={delivery}
                endpointName={endpointsById.get(delivery.endpointId)?.name ?? null}
              />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/**
 * One endpoint: its state, and the edits that change it.
 *
 * Pausing is a single field (`active`), and resuming clears an automatic
 * suspension too, which is how somebody reconnects an endpoint whose server was
 * down long enough to hit the failure threshold.
 *
 * A PAUSED ENDPOINT AND AN AUTO-SUSPENDED ONE LOOK IDENTICAL HERE, because the
 * API returns one derived `active` flag for both: it also stores a suspension
 * timestamp when a human pauses, so `suspendedAt` cannot be used to tell who did
 * it. So the row says "paused" for both, and the failures count beside it is
 * what tells somebody their server, not their own decision, is the cause.
 */
function EndpointRow({
  organizationId,
  endpoint,
  events,
  editing,
  onEdit,
  onEdited,
}: {
  organizationId: string;
  endpoint: WebhookEndpointRow;
  events: WebhookEventName[];
  editing: boolean;
  onEdit: () => void;
  onEdited: () => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function setActive(active: boolean) {
    setBusy(true);
    setError(null);
    const res = await patchWebhookEndpoint(organizationId, endpoint.id, { active });
    setBusy(false);
    if (!res.ok) setError(res.error.message ?? "That change could not be saved.");
    else router.refresh();
  }

  async function remove() {
    setBusy(true);
    setError(null);
    const res = await deleteWebhookEndpoint(organizationId, endpoint.id);
    setBusy(false);
    if (!res.ok) {
      setError(res.error.message ?? "The endpoint could not be deleted.");
      return;
    }
    router.refresh();
  }

  return (
    <li
      className="flex flex-col gap-2 border-b py-3"
      style={{ borderColor: "rgba(255,255,255,0.055)" }}
      data-testid={`webhook-endpoint-${endpoint.id}`}
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <div className="min-w-0 flex-1">
          <div className="text-[13px]" style={{ color: "var(--color-ink)" }}>
            {endpoint.name}
          </div>
          <div className="num break-all text-[11px]" style={{ color: "var(--color-ink-3)" }}>
            {endpoint.url} · {endpoint.events.join(", ")}
          </div>
          <div className="num text-[11px]" style={{ color: "var(--color-ink-3)" }}>
            {endpoint.lastDeliveryAt
              ? `last delivered ${new Date(endpoint.lastDeliveryAt).toLocaleString("en-GB")}`
              : "nothing delivered yet"}
            {endpoint.failureCount > 0
              ? ` · ${endpoint.failureCount} failed attempt${endpoint.failureCount === 1 ? "" : "s"}`
              : ""}
            {endpoint.suspendedAt
              ? ` · suspension recorded ${new Date(endpoint.suspendedAt).toLocaleString("en-GB")}`
              : ""}
          </div>
        </div>

        <span
          className="num text-[10px] tracking-[0.12em] uppercase"
          style={{
            color: endpoint.active ? "var(--color-pass)" : "var(--color-unmeasured)",
          }}
        >
          {endpoint.active ? "active" : "paused"}
        </span>

        <div className="flex items-center gap-3">
          {editing ? null : (
            <>
              <button
                type="button"
                onClick={() => setActive(!endpoint.active)}
                disabled={busy}
                className="text-[11.5px] underline"
                style={{ color: "var(--color-ink-2)" }}
                data-testid={`webhook-toggle-${endpoint.id}`}
              >
                {endpoint.active ? "pause" : "resume"}
              </button>
              <button
                type="button"
                onClick={onEdit}
                disabled={busy}
                className="text-[11.5px] underline"
                style={{ color: "var(--color-ink-2)" }}
                data-testid={`webhook-edit-${endpoint.id}`}
              >
                edit
              </button>
              <ConfirmAction
                label="delete"
                confirmLabel="Delete endpoint"
                consequence={`Delete ${endpoint.name}? Delivery stops at once and its delivery history goes with it.`}
                onConfirm={remove}
                testId={`webhook-delete-${endpoint.id}`}
                busy={busy}
              />
            </>
          )}
        </div>
      </div>

      {/* A paused endpoint with failures behind it is very likely one the failure
          threshold stopped rather than one a person paused, and the API reports
          both the same way. Say which it looks like, and what resuming does. */}
      {!endpoint.active && endpoint.failureCount > 0 ? (
        <p className="text-[12px]" style={{ color: "var(--color-block)" }}>
          Paused after {endpoint.failureCount} failed attempt
          {endpoint.failureCount === 1 ? "" : "s"}: either somebody stopped it by
          hand or the failure threshold suspended it, and the API reports both the
          same way. Resuming clears the pause and gives it a fresh attempt count.
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="text-[12.5px]" style={{ color: "var(--color-block)" }}>
          {error}
        </p>
      ) : null}

      {editing ? (
        <EndpointEditor
          organizationId={organizationId}
          endpoint={endpoint}
          events={events}
          onDone={onEdited}
        />
      ) : null}
    </li>
  );
}

/**
 * The edit form for one endpoint, mounted only while it is open.
 *
 * Its state is seeded from the endpoint on mount, so reopening the form always
 * shows what is actually stored rather than a stale draft left over from the
 * last time it was open.
 */
function EndpointEditor({
  organizationId,
  endpoint,
  events,
  onDone,
}: {
  organizationId: string;
  endpoint: WebhookEndpointRow;
  events: WebhookEventName[];
  onDone: () => void;
}) {
  const router = useRouter();
  const [name, setName] = useState(endpoint.name);
  const [url, setUrl] = useState(endpoint.url);
  const [selected, setSelected] = useState<WebhookEventName[]>(endpoint.events);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const urlOk = /^https:\/\/[^\s/$.?#][^\s]*$/i.test(url.trim());
  const canSave =
    name.trim().length >= 2 &&
    name.trim().length <= 80 &&
    url.trim().length >= 1 &&
    url.trim().length <= 500 &&
    urlOk &&
    selected.length >= 1 &&
    selected.length <= 4;

  async function save() {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    const res = await patchWebhookEndpoint(organizationId, endpoint.id, {
      name: name.trim(),
      url: url.trim(),
      events: selected,
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.error.message ?? "That change could not be saved.");
      return;
    }
    onDone();
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-2.5">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <span className="label">Name</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            minLength={2}
            maxLength={80}
            data-testid={`webhook-edit-name-${endpoint.id}`}
            style={INPUT_STYLE}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="label">Endpoint URL</span>
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            maxLength={500}
            inputMode="url"
            spellCheck={false}
            data-testid={`webhook-edit-url-${endpoint.id}`}
            style={INPUT_STYLE}
          />
        </label>
      </div>
      {url.trim().length > 0 && !urlOk ? (
        <p role="status" className="text-[12.5px]" style={{ color: "var(--color-unverified)" }}>
          The endpoint must be a public <span className="num">https</span> address.
          The API refuses anything else.
        </p>
      ) : null}
      <fieldset className="flex flex-col gap-2">
        <legend className="label">Events to send</legend>
        <div className="flex flex-wrap gap-x-5 gap-y-1.5">
          {events.map((event) => (
            <label
              key={event}
              className="flex items-center gap-2 text-[12.5px]"
              style={{ color: "var(--color-ink-2)" }}
            >
              <input
                type="checkbox"
                checked={selected.includes(event)}
                onChange={() =>
                  setSelected((prev) =>
                    prev.includes(event) ? prev.filter((e) => e !== event) : [...prev, event],
                  )
                }
              />
              <span className="num">{event}</span>
            </label>
          ))}
        </div>
        {selected.length === 0 ? (
          <p role="status" className="text-[12.5px]" style={{ color: "var(--color-unverified)" }}>
            At least one event is required: the API refuses an endpoint subscribed
            to nothing, and it would never be sent anything.
          </p>
        ) : null}
      </fieldset>
      {error ? (
        <p role="alert" className="text-[12.5px]" style={{ color: "var(--color-block)" }}>
          {error}
        </p>
      ) : null}
      <div className="flex items-center gap-3">
        <ActionButton
          label="Save changes"
          loadingLabel="Saving…"
          busy={busy}
          disabled={!canSave}
          onClick={save}
          testId={`webhook-save-${endpoint.id}`}
          style={{ padding: "7px 14px" }}
        />
        <button
          type="button"
          onClick={onDone}
          disabled={busy}
          className="text-[12px]"
          style={{ color: "var(--color-ink-3)" }}
        >
          cancel
        </button>
      </div>
    </div>
  );
}

/**
 * One delivery attempt: what was sent, what came back, and what to do about it.
 *
 * Replay is deliberately absent on a delivery that succeeded. The API would
 * accept it, and it would send the customer's own integration a second copy of
 * an event they have already processed, which is the kind of bug that makes a
 * team disable the endpoint entirely.
 */
function DeliveryRow({
  organizationId,
  delivery,
  endpointName,
}: {
  organizationId: string;
  delivery: WebhookDeliveryRow;
  endpointName: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const replayable = canReplayWebhookDelivery(delivery);

  async function replay() {
    setBusy(true);
    setError(null);
    const res = await replayWebhookDelivery(organizationId, delivery.id);
    setBusy(false);
    if (!res.ok) {
      setError(res.error.message ?? "The delivery could not be replayed.");
      return;
    }
    router.refresh();
  }

  return (
    <li
      className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b py-3"
      style={{ borderColor: "rgba(255,255,255,0.055)" }}
      data-testid={`webhook-delivery-${delivery.id}`}
    >
      <div className="min-w-0 flex-1">
        <div className="num text-[12.5px]" style={{ color: "var(--color-ink)" }}>
          {delivery.event}
          {endpointName ? (
            <span style={{ color: "var(--color-ink-3)" }}> · {endpointName}</span>
          ) : null}
        </div>
        <div className="num text-[11px]" style={{ color: "var(--color-ink-3)" }}>
          {delivery.attempts} attempt{delivery.attempts === 1 ? "" : "s"}
          {delivery.responseCode !== null
            ? ` · HTTP ${delivery.responseCode}`
            : delivery.lastError
              ? " · no response"
              : " · not sent yet"}
          {" · queued "}
          {new Date(delivery.createdAt).toLocaleString("en-GB")}
          {delivery.deliveredAt
            ? ` · delivered ${new Date(delivery.deliveredAt).toLocaleString("en-GB")}`
            : ""}
        </div>
        {delivery.lastError ? (
          <div className="num text-[11.5px]" style={{ color: "var(--color-block)" }}>
            {delivery.lastError}
          </div>
        ) : null}
      </div>

      <span
        className="num text-[10px] tracking-[0.12em] uppercase"
        style={{ color: STATUS_TONE[delivery.status] }}
      >
        {delivery.status.toLowerCase()}
      </span>

      {replayable ? (
        <button
          type="button"
          onClick={replay}
          disabled={busy}
          className="text-[11.5px] underline"
          style={{ color: "var(--color-ink-2)", opacity: busy ? 0.6 : 1 }}
          data-testid={`webhook-replay-${delivery.id}`}
        >
          {busy ? "requeueing…" : "replay"}
        </button>
      ) : null}

      {error ? (
        <p role="alert" className="w-full text-[12px]" style={{ color: "var(--color-block)" }}>
          {error}
        </p>
      ) : null}
    </li>
  );
}

const INPUT_STYLE = {
  background: "var(--color-elevate)",
  border: "1px solid var(--color-line-strong)",
  borderRadius: 2,
  color: "var(--color-ink)",
  padding: "7px 10px",
  fontSize: 14,
  outline: "none",
} as const;
