"use client";

/**
 * webhooks.tsx — signed events posted to your own systems.
 *
 * Read in the order an integrator needs it: the figures for the last fifty
 * deliveries (is anything failing?), each endpoint drawn as a line from this
 * workspace to it with its state in a word, the record of what was sent and
 * what came back (the place to look when "the ticket never got created"), then
 * adding an endpoint beside how to check a signature. The signing secret is
 * returned once on creation and is shown once.
 *
 * The retry and suspension behaviour stated here is the API's own
 * (webhook.service.ts): five attempts on a widening ladder, suspension after
 * sustained failure, and a later probe. Resuming an endpoint clears it.
 *
 * Test hooks: webhook-secret, webhook-event-<event>; the plan refusal is the
 * UpgradeNotice section carrying data-feature="integrations.webhooks".
 */

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import {
  createWebhookEndpoint,
  deleteWebhookEndpoint,
  patchWebhookEndpoint,
  queueWebhookTest,
  replayWebhookDelivery,
} from "@/lib/webhooks-client";
import type { RegisteredWebhook, WebhookDeliveryStatus, WebhookEventName } from "@/lib/types";
import type { FeatureStatus } from "@/lib/entitlements";
import { ActionRefusal, type ActionError } from "@/components/harbor/plan-refusal";
import { UpgradeNotice } from "@/components/ui/states";
import { Badge, type Tone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/choice";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { Readout, ReadoutStrip } from "@/components/ui/readout";
import { Nil, Table, TBody, Td, TEmptyRow, Th, THead, Tr } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { ConnectionLine, type LineState } from "./lines";
import { OnceSecret, Panel } from "./parts";

const EVENT_WORDS: Record<WebhookEventName, string> = {
  "domain.verified": "A domain's ownership is verified",
  "alert.triggered": "An alert rule fires",
  "report.received": "A DMARC report arrives",
  "entitlement.exceeded": "The workspace goes over a plan limit",
  "dns.changed": "DNS records changed",
  "policy.changed": "DMARC policy changed",
  "forensic.received": "Forensic report received",
  "tlsrpt.received": "TLS report received",
};

const STATUS: Record<WebhookDeliveryStatus, [string, Tone]> = {
  PENDING: ["Waiting to send", "neutral"],
  IN_FLIGHT: ["Sending", "accent"],
  DELIVERED: ["Delivered", "ok"],
  FAILED: ["Gave up", "fail"],
  SUSPENDED: ["Held: endpoint suspended", "warn"],
};

export interface EndpointView {
  id: string;
  name: string;
  url: string;
  events: WebhookEventName[];
  active: boolean;
  suspendedUntilLabel: string | null;
  failureCount: number;
  lastDeliveryLabel: string | null;
}

export interface DeliveryView {
  id: string;
  endpointName: string;
  event: string;
  status: WebhookDeliveryStatus;
  attempts: number;
  responseCode: number | null;
  lastError: string | null;
  whenLabel: string;
  replayable: boolean;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function WebhooksBoard({
  organizationId,
  endpoints,
  deliveries,
  events,
  defaultEvents,
  canManage,
  webhookFeature,
  webhooksPlanLabel,
}: {
  organizationId: string;
  endpoints: EndpointView[];
  deliveries: DeliveryView[] | null;
  events: WebhookEventName[];
  defaultEvents: WebhookEventName[];
  canManage: boolean;
  webhookFeature: FeatureStatus;
  webhooksPlanLabel: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [chosen, setChosen] = useState<WebhookEventName[]>(defaultEvents);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ActionError | null>(null);
  const [created, setCreated] = useState<RegisteredWebhook | null>(null);

  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<EndpointView | null>(null);
  const [testNotice, setTestNotice] = useState<string | null>(null);

  const webhooksUnavailable = webhookFeature === false;

  async function add(e: FormEvent) {
    e.preventDefault();
    if (busy || chosen.length === 0 || webhooksUnavailable) return;
    setBusy(true);
    setError(null);
    const res = await createWebhookEndpoint(organizationId, { name: name.trim(), url: url.trim(), events: chosen });
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setCreated(res.data);
    setName("");
    setUrl("");
    setChosen(defaultEvents);
    router.refresh();
  }

  async function setActive(ep: EndpointView, active: boolean) {
    setRowBusy(ep.id);
    setRowError(null);
    const res = await patchWebhookEndpoint(organizationId, ep.id, { active });
    setRowBusy(null);
    if (!res.ok) {
      setRowError(res.error.message ?? "The change did not go through.");
      return;
    }
    toast({ title: active ? `${ep.name} is receiving again` : `${ep.name} is paused`, tone: "ok" });
    router.refresh();
  }

  async function remove() {
    if (!removing) return;
    setRowBusy(removing.id);
    const res = await deleteWebhookEndpoint(organizationId, removing.id);
    setRowBusy(null);
    if (!res.ok && res.status !== 404) {
      setRowError(res.error.message ?? "The endpoint could not be removed.");
      setRemoving(null);
      return;
    }
    toast({ title: `${removing.name} is removed`, tone: "ok" });
    setRemoving(null);
    router.refresh();
  }

  async function test() {
    setRowBusy("test");
    setTestNotice(null);
    const res = await queueWebhookTest(organizationId);
    setRowBusy(null);
    if (!res.ok) {
      setRowError(res.error.message ?? "The test event could not be queued.");
      return;
    }
    setTestNotice(res.data.notice);
    router.refresh();
  }

  async function replay(d: DeliveryView) {
    setRowBusy(d.id);
    const res = await replayWebhookDelivery(organizationId, d.id);
    setRowBusy(null);
    if (!res.ok) {
      setRowError(res.error.message ?? "The delivery could not be queued again.");
      return;
    }
    toast({ title: "Queued to send again", body: "Same payload, fresh signature.", tone: "ok" });
    router.refresh();
  }

  const receiving = endpoints.filter((ep) => ep.active && !ep.suspendedUntilLabel && !webhooksUnavailable).length;
  const count = (s: WebhookDeliveryStatus[]) => (deliveries ? deliveries.filter((d) => s.includes(d.status)).length : null);
  const delivered = count(["DELIVERED"]);
  const gaveUp = count(["FAILED"]);
  const waiting = count(["PENDING", "IN_FLIGHT", "SUSPENDED"]);

  return (
    <div className="flex flex-col gap-10">
      {webhooksUnavailable ? (
        <UpgradeNotice
          message={`Webhooks are not included in this workspace's plan. They are included from ${webhooksPlanLabel}.`}
          feature="integrations.webhooks"
          context="Endpoints already configured are kept. Delivery resumes when the plan grants webhooks again."
        />
      ) : null}
      {created ? (
        <OnceSecret
          testId="webhook-secret"
          title={`${created.name}: copy the signing secret now`}
          value={created.secret}
          label="signing secret"
          onDismiss={() => setCreated(null)}
        >
          {created.notice ?? "Copy the secret now. It is stored encrypted and is never shown again."} Your system uses it
          to check that each request really came from here; the recipe is at the bottom of this page.
        </OnceSecret>
      ) : null}

      {endpoints.length > 0 ? (
        <ReadoutStrip>
          <Readout
            label="Endpoints receiving"
            value={receiving}
            unit={`of ${endpoints.length}`}
            tone={receiving < endpoints.length ? "warn" : undefined}
            note={receiving < endpoints.length ? "The rest are paused or suspended." : "Every endpoint is receiving."}
          />
          <Readout label="Delivered" value={delivered ?? <Nil label="not read" />} note="Of the last fifty sent." />
          <Readout
            label="Gave up"
            value={gaveUp ?? <Nil label="not read" />}
            tone={gaveUp ? "fail" : undefined}
            note={gaveUp ? "After five tries. Each can be sent again below." : "Nothing given up."}
          />
          <Readout label="Waiting or held" value={waiting ?? <Nil label="not read" />} note="Queued, sending, or held for a suspended endpoint." />
        </ReadoutStrip>
      ) : null}

      <Panel
        id="wh-endpoints"
        title="Endpoints"
        why="Each receives the events it subscribes to as a signed POST. A paused or suspended endpoint receives nothing until it is resumed."
        aside={
          canManage && endpoints.length > 0 && !webhooksUnavailable ? (
            <Button size="sm" onClick={test} busy={rowBusy === "test"} busyLabel="Queuing a test event">
              Send a test event
            </Button>
          ) : null
        }
      >
        {endpoints.length === 0 ? (
          <ConnectionLine
            state="none"
            word="No endpoint yet"
            detail="Nothing is sent anywhere. Add one below."
            label="Workspace events to your systems: no endpoint yet."
            from={{ name: "This workspace", kind: "alerts, reports, DNS changes" }}
            to={{ name: "Your system", kind: "a PSA, ticketing or SIEM" }}
          />
        ) : (
          <ul className="flex flex-col">
            {endpoints.map((ep) => {
              const state: LineState = webhooksUnavailable
                ? "paused"
                : ep.suspendedUntilLabel || (ep.active && ep.failureCount > 0)
                  ? "failing"
                  : ep.active
                    ? "live"
                    : "paused";
              const word = webhooksUnavailable
                ? "Paused"
                : ep.suspendedUntilLabel
                  ? "Suspended after repeated failures"
                  : !ep.active
                    ? "Paused"
                    : ep.failureCount > 0
                      ? "Failing"
                      : "Receiving";
              const detail = webhooksUnavailable
                ? `Webhooks are included from ${webhooksPlanLabel}.`
                : ep.suspendedUntilLabel
                  ? `Until ${ep.suspendedUntilLabel}, then probed. Resume to clear it now.`
                  : ep.failureCount > 0
                    ? `${ep.failureCount} recent failure${ep.failureCount === 1 ? "" : "s"}; retries continue.`
                    : ep.lastDeliveryLabel
                      ? `Last delivered ${ep.lastDeliveryLabel}.`
                      : "Nothing delivered yet.";
              return (
                <li key={ep.id} className="flex flex-col gap-3 border-b border-rule py-5 first:pt-1">
                  <ConnectionLine
                    state={state}
                    word={word}
                    detail={detail}
                    label={`This workspace to ${ep.name}: ${word.toLowerCase()}.`}
                    aside={
                      canManage ? (
                        <>
                          {webhooksUnavailable ? null : ep.active ? (
                            <Button size="sm" variant="ghost" onClick={() => setActive(ep, false)} busy={rowBusy === ep.id} busyLabel="Pausing">
                              Pause
                            </Button>
                          ) : (
                            <Button size="sm" variant="secondary" onClick={() => setActive(ep, true)} busy={rowBusy === ep.id} busyLabel="Resuming">
                              Resume
                            </Button>
                          )}
                          <Button size="sm" variant="ghost" className="text-fail hover:text-fail" onClick={() => setRemoving(ep)}>
                            Remove
                          </Button>
                        </>
                      ) : null
                    }
                    from={{ name: "This workspace", kind: `${ep.events.length} event${ep.events.length === 1 ? "" : "s"}, signed` }}
                    to={{ name: ep.name, kind: hostOf(ep.url) }}
                  />
                  <dl className="grid gap-x-4 gap-y-1 text-meta sm:grid-cols-[96px_minmax(0,1fr)]">
                    <dt className="font-semibold text-fg-3">Posts to</dt>
                    <dd className="min-w-0">
                      <code className="data break-all text-fg-2">{ep.url}</code>
                    </dd>
                    <dt className="font-semibold text-fg-3">Sends when</dt>
                    <dd className="min-w-0 text-fg-2">{ep.events.map((e) => EVENT_WORDS[e] ?? e).join(" · ")}</dd>
                  </dl>
                </li>
              );
            })}
          </ul>
        )}
        {testNotice ? <Notice tone="info" title={testNotice} /> : null}
        {rowError ? <Notice tone="fail" title={rowError} /> : null}
      </Panel>

      {endpoints.length === 0 && deliveries?.length === 0 ? null : (
        <Panel
          id="wh-log"
          title="What was sent"
          why="The last fifty deliveries, newest first. A failed one is tried again after 1, 5, 30 and 120 minutes, five attempts in all, before it is given up; one that gave up can be sent again."
        >
          {deliveries === null ? (
            <Notice tone="warn" title="The delivery record could not be read">
              This is not the same as nothing having been sent. Reload to try again.
            </Notice>
          ) : (
            <Table caption="Webhook deliveries" minWidth={820} dense>
              <THead>
                <tr>
                  <Th>When</Th>
                  <Th>Event</Th>
                  <Th>Endpoint</Th>
                  <Th>Outcome</Th>
                  <Th numeric>Tries</Th>
                  <Th>Your system said</Th>
                  <Th align="right">
                    <span className="sr-only">Action</span>
                  </Th>
                </tr>
              </THead>
              <TBody>
                {deliveries.length === 0 ? (
                  <TEmptyRow colSpan={7}>Nothing has been sent yet.</TEmptyRow>
                ) : (
                  deliveries.map((d) => {
                    const [word, tone] = STATUS[d.status] ?? [d.status, "neutral" as Tone];
                    return (
                      <Tr key={d.id} tone={d.status === "FAILED" ? "fail" : d.status === "SUSPENDED" ? "warn" : undefined}>
                        <Td className="tnum whitespace-nowrap text-meta">{d.whenLabel}</Td>
                        <Td mono className="text-meta">
                          {d.event}
                        </Td>
                        <Td className="text-meta">{d.endpointName}</Td>
                        <Td>
                          <Badge tone={tone}>{word}</Badge>
                        </Td>
                        <Td numeric>{d.attempts}</Td>
                        <Td className="max-w-[280px] text-meta">
                          {d.responseCode !== null ? <span className="data font-semibold">HTTP {d.responseCode}</span> : null}
                          {d.lastError ? <span className="block break-words text-fg-3">{d.lastError}</span> : null}
                          {d.responseCode === null && !d.lastError ? <Nil label="no answer recorded" /> : null}
                        </Td>
                        <Td align="right">
                          {canManage && !webhooksUnavailable && d.replayable ? (
                            <Button size="sm" variant="ghost" onClick={() => replay(d)} busy={rowBusy === d.id} busyLabel="Queuing">
                              Send again
                            </Button>
                          ) : null}
                        </Td>
                      </Tr>
                    );
                  })
                )}
              </TBody>
            </Table>
          )}
        </Panel>
      )}

      <div className="grid gap-x-12 gap-y-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
        {canManage ? (
          <Panel id="wh-add" title="Add an endpoint" why="A public https address on your side. Private and local addresses are refused, and redirects are not followed.">
            {webhooksUnavailable ? (
              <p className="text-meta text-fg-3">
                Adding an endpoint is unavailable on this plan. It is included from {webhooksPlanLabel}.
              </p>
            ) : null}
            <form onSubmit={add} className="grid max-w-[680px] gap-4">
              <Field label="Name" hint="The system it feeds: PSA, ticketing, SIEM.">
                <Input value={name} onChange={(e) => setName(e.target.value)} minLength={2} maxLength={80} required autoComplete="off" disabled={webhooksUnavailable} />
              </Field>
              <Field label="URL">
                <Input type="url" mono value={url} onChange={(e) => setUrl(e.target.value)} maxLength={500} required placeholder="https://hooks.youragency.example/dmarc" disabled={webhooksUnavailable} />
              </Field>
              <fieldset className="flex flex-col gap-2.5">
                <legend className="mb-1 text-meta font-semibold text-fg-2">Send it when</legend>
                {events.map((ev) => (
                  <Checkbox
                    key={ev}
                    checked={chosen.includes(ev)}
                    onChange={(e) => setChosen((c) => (e.target.checked ? [...c, ev] : c.filter((x) => x !== ev)))}
                    label={EVENT_WORDS[ev] ?? ev}
                    hint={<code className="data">{ev}</code>}
                    disabled={webhooksUnavailable}
                    data-testid={`webhook-event-${ev}`}
                  />
                ))}
                {chosen.length === 0 ? <p className="text-meta font-medium text-fail">Choose at least one.</p> : null}
              </fieldset>
              <ActionRefusal error={error} />
              <div>
                <Button type="submit" variant="primary" busy={busy} busyLabel="Adding the endpoint" disabled={chosen.length === 0 || webhooksUnavailable}>
                  Add endpoint
                </Button>
              </div>
            </form>
          </Panel>
        ) : null}

        <Panel id="wh-verify" title="Checking a signature" why="Refuse any request whose signature does not match. It is the only proof a request came from here.">
          <ul className="flex flex-col gap-1.5 text-ui text-fg-2">
            <li>
              <code className="data text-fg">x-dmarcharbor-signature</code>: <code className="data">sha256=</code> and a hex HMAC
            </li>
            <li>
              <code className="data text-fg">x-dmarcharbor-timestamp</code>: Unix seconds; reject old ones to stop replays
            </li>
            <li>
              <code className="data text-fg">x-dmarcharbor-event</code>, <code className="data text-fg">x-dmarcharbor-delivery</code>,{" "}
              <code className="data text-fg">x-dmarcharbor-attempt</code>
            </li>
            <li>A delivery may arrive more than once: use the delivery id to ignore repeats.</li>
          </ul>
          <pre className="data overflow-x-auto rounded-ctl bg-paper-3 px-3 py-2.5 text-meta leading-[1.6] text-fg">
{`const expected = "sha256=" + crypto
  .createHmac("sha256", secret)
  .update(\`\${timestamp}.\${rawBody}\`)
  .digest("hex");
// compare with timingSafeEqual`}
          </pre>
        </Panel>
      </div>

      <ConfirmDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        onConfirm={remove}
        title={removing ? `Remove ${removing.name}?` : "Remove this endpoint?"}
        body={
          removing ? (
            <p>
              Nothing more is sent to <span className="data text-fg">{removing.url}</span>, and its delivery record goes with
              it. To stop it for a while instead, pause it.
            </p>
          ) : null
        }
        confirmLabel="Remove endpoint"
        busy={rowBusy === removing?.id}
        danger
      />
    </div>
  );
}
