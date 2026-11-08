"use client";

/**
 * chat-channels.tsx — the Slack and Teams settings pages: several channels per
 * workspace, each routed by client and kind of message.
 *
 * Read in the order an MSP checks it:
 *   the map      every channel as its own line from the alerts to that
 *                channel, coloured one line per channel, with what it carries
 *                written on it; a paused channel is a grey dashed line and a
 *                failing one is red, with the state in a word beside it;
 *   the list     each channel's masked address, what it receives, its last
 *                delivery, and its own test, pause, routing and removal;
 *   the form     add a channel, routed from the start, with the service's own
 *                steps drawn beside it.
 *
 * The address is the credential: whoever holds it can post into the channel.
 * It goes in through an uncontrolled field that clears on save, is stored
 * encrypted, and comes back only masked.
 *
 * Plan: adding, changing, switching on and testing need alerts.email. Without
 * it the form and the edits are not offered; kept channels stay listed with
 * their pause and removal, which are allowed on every plan.
 *
 * Test hooks (prefix is slack or teams): {p}-map, {p}-channel (data-state),
 * {p}-masked, {p}-test, {p}-test-result, {p}-route-edit, {p}-remove,
 * {p}-webhook, {p}-label, {p}-save, {p}-error; the plan gate is the
 * UpgradeNotice carrying data-feature="alerts.email".
 */

import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent, type ReactNode } from "react";
import { clsx } from "clsx";
import { CHAT_KINDS, clientsSentence, kindsSentence } from "@/lib/chat-kinds";
import { createChatDestination, deleteChatDestination, testChatDestination, updateChatDestination, type ChatService } from "@/lib/ops-client";
import type { FeatureStatus } from "@/lib/entitlements";
import { instantLabel } from "@/lib/instant";
import type { SlackDestination } from "@/lib/types";
import { ActionRefusal, isPlanRefusal, type ActionError } from "@/components/harbor/plan-refusal";
import { Button } from "@/components/ui/button";
import { Checkbox, Switch } from "@/components/ui/choice";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Field, Input, Segmented } from "@/components/ui/field";
import { KeyValue, Notice } from "@/components/ui/notice";
import { UpgradeNotice } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { StateWord } from "../ops-parts";
import { SetupSteps } from "./lines";
import { Panel } from "./parts";
import { ClientScope, type ClientChoice } from "./webhook-parts";

/** One colour per channel line, never red (red is a failing channel). */
const LINE = ["bg-route-blue", "bg-route-orange", "bg-route-green", "bg-route-purple", "bg-route-yellow"] as const;

export interface ChatCopy {
  service: ChatService;
  /** Test id prefix. */
  prefix: "slack" | "teams";
  /** "Slack", "Microsoft Teams". */
  name: string;
  /** "Slack", "Teams": in buttons. */
  short: string;
  addressLabel: string;
  addressHint: string;
  placeholder: string;
  labelPlaceholder: string;
  /** What the terminus says it is, e.g. "Slack, by incoming webhook". */
  kindOfChannel: string;
  stepsTitle: string;
  steps: Array<{ key: string; name: string; detail: ReactNode }>;
  /** Shown above the add form, e.g. Teams' note about the Workflows bot. */
  intro?: ReactNode;
  saveError: (code: string | undefined, message: string | undefined) => string;
  testSent: string;
  testRefused: (reason: string) => string;
}

type Channel = SlackDestination & { id: string };

function channelState(c: Channel, offPlan: boolean): "live" | "paused" | "failing" {
  if (offPlan || !c.enabled) return "paused";
  return c.consecutiveFailures > 0 ? "failing" : "live";
}

export function ChatChannelsBoard({
  copy,
  organizationId,
  destinations,
  clients,
  canManage,
  alerting = null,
  includedFrom = "included on a higher plan",
}: {
  copy: ChatCopy;
  organizationId: string;
  destinations: SlackDestination[];
  clients: ClientChoice[] | null;
  canManage: boolean;
  alerting?: FeatureStatus;
  includedFrom?: string;
}) {
  const offPlan = alerting === false;
  const channels = destinations.filter((d): d is Channel => typeof d.id === "string");
  const p = copy.prefix;

  return (
    <div className="flex flex-col gap-10">
      {offPlan ? (
        <UpgradeNotice
          feature="alerts.email"
          message={`${copy.name} alerts are not included in this workspace's plan. They are ${includedFrom}.`}
          context={
            channels.length
              ? "The channels you connected are kept, but nothing is sent to them on this plan. You can still pause or remove them below."
              : "Nothing is connected, and nothing about this workspace changes."
          }
        />
      ) : null}

      <ChannelMap copy={copy} channels={channels} clients={clients} offPlan={offPlan} />

      {channels.length > 0 ? (
        <Panel
          id={`${p}-channels`}
          title="Channels"
          why="Each one receives the alerts, DNS changes and expiry warnings it is routed to. Email alerts are unaffected."
          aside={`${channels.length} of 20`}
        >
          <ul className="flex flex-col">
            {channels.map((c, i) => (
              <ChannelRow
                key={c.id}
                copy={copy}
                organizationId={organizationId}
                channel={c}
                index={i}
                clients={clients}
                canManage={canManage}
                offPlan={offPlan}
              />
            ))}
          </ul>
        </Panel>
      ) : null}

      {offPlan ? null : (
        <AddChannel copy={copy} organizationId={organizationId} clients={clients} canManage={canManage} first={channels.length === 0} full={channels.length >= 20} />
      )}
    </div>
  );
}

/** Every channel as a line from the alerts to it, with what it carries. */
function ChannelMap({ copy, channels, clients, offPlan }: { copy: ChatCopy; channels: Channel[]; clients: ClientChoice[] | null; offPlan: boolean }) {
  const p = copy.prefix;
  return (
    <figure className="m-0" data-testid={`${p}-map`} aria-label={`Where alerts go in ${copy.name}`}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-rule pb-3">
        <span className="text-body font-bold text-fg">Where alerts go</span>
        <span className="text-meta text-fg-3">
          {channels.length === 0 ? `no ${copy.short} channel yet` : `${channels.length} ${copy.short} channel${channels.length === 1 ? "" : "s"}, each routed by client and kind`}
        </span>
      </div>
      <div className="mt-5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3">
        <div className="flex flex-col items-center pt-[3px]">
          <span aria-hidden className="size-[17px] shrink-0 rounded-full border-[3px] border-fg bg-paper" />
          {channels.length > 1 ? <span aria-hidden className="w-[5px] flex-1 bg-fg" /> : null}
        </div>
        <div className="min-w-0">
          <p className="text-ui font-bold text-fg">
            Alert rules, DNS changes and expiry <span className="font-normal text-fg-3">for every client</span>
          </p>
          <ol className="m-0 mt-3 flex list-none flex-col gap-3 p-0">
            {channels.length === 0 ? (
              <li className="flex items-center gap-3">
                <span aria-hidden className="h-0 flex-1 border-t-[3px] border-dotted border-rule-2" />
                <span aria-hidden className="h-4 w-7 shrink-0 rounded-full border-[3px] border-rule-2 bg-paper" />
                <span className="w-44 shrink-0 text-meta text-fg-3">Not connected</span>
              </li>
            ) : (
              channels.map((c, i) => {
                const state = channelState(c, offPlan);
                return (
                  <li key={c.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-x-3 gap-y-1 sm:grid-cols-[minmax(0,1fr)_auto_11rem]">
                    <span className="flex min-w-0 flex-col gap-1">
                      <span className="truncate text-[12px] text-fg-3">
                        {kindsSentence(c.kinds ?? []).replace(/^./, (ch) => ch.toUpperCase())} · {clientsSentence(c.clientIds ?? [], clients)}
                      </span>
                      <span
                        aria-hidden
                        className={clsx(
                          "mb-[6px] block h-[5px] rounded-full",
                          state === "live" && LINE[i % LINE.length],
                          state === "paused" && "bg-[repeating-linear-gradient(90deg,var(--color-rule-2)_0_9px,transparent_9px_15px)]",
                          state === "failing" && "bg-[repeating-linear-gradient(90deg,var(--color-fail)_0_9px,transparent_9px_15px)]",
                        )}
                      />
                    </span>
                    <span
                      aria-hidden
                      className={clsx(
                        "h-[17px] w-7 shrink-0 rounded-full border-[3px] bg-paper",
                        state === "failing" ? "border-fail" : state === "paused" ? "border-rule-2" : "border-fg",
                      )}
                    />
                    <span className="col-span-2 min-w-0 sm:col-span-1">
                      <span className="block truncate text-ui font-bold text-fg">{c.channelLabel ?? `${copy.short} channel`}</span>
                      <StateWord
                        shape={state === "live" ? "square" : state === "failing" ? "diamond" : "half"}
                        tone={state === "live" ? "ok" : state === "failing" ? "fail" : "void"}
                        className="text-meta!"
                      >
                        {state === "live" ? "Delivering" : state === "failing" ? "Failing" : "Paused"}
                      </StateWord>
                    </span>
                  </li>
                );
              })
            )}
          </ol>
        </div>
      </div>
    </figure>
  );
}

function ChannelRow({
  copy,
  organizationId,
  channel,
  index,
  clients,
  canManage,
  offPlan,
}: {
  copy: ChatCopy;
  organizationId: string;
  channel: Channel;
  index: number;
  clients: ClientChoice[] | null;
  canManage: boolean;
  offPlan: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const p = copy.prefix;
  const [enabled, setEnabled] = useState(channel.enabled);
  const [toggleBusy, setToggleBusy] = useState(false);
  const [testBusy, setTestBusy] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [planError, setPlanError] = useState<ActionError | null>(null);
  const state = channelState({ ...channel, enabled }, offPlan);

  async function toggle(next: boolean) {
    setToggleBusy(true);
    setError(null);
    const res = await updateChatDestination(organizationId, copy.service, channel.id, { enabled: next });
    setToggleBusy(false);
    if (!res.ok) {
      if (isPlanRefusal(res.error)) setPlanError(res.error);
      else setError(res.error.message ?? "The change did not go through.");
      return;
    }
    setEnabled(next);
    router.refresh();
  }

  async function sendTest() {
    setTestBusy(true);
    setTestResult(null);
    const res = await testChatDestination(organizationId, copy.service, channel.id);
    setTestBusy(false);
    if (!res.ok) {
      if (isPlanRefusal(res.error)) {
        setPlanError(res.error);
        return;
      }
      setTestResult(res.error.message && !/^[A-Z_]+$/.test(res.error.message) ? res.error.message : "The test message could not be sent. Nothing else changed.");
      return;
    }
    setTestResult(res.data.delivered ? copy.testSent : copy.testRefused(res.data.error ?? "no reason given"));
    router.refresh();
  }

  async function remove() {
    setRemoveBusy(true);
    const res = await deleteChatDestination(organizationId, copy.service, channel.id);
    setRemoveBusy(false);
    setRemoveOpen(false);
    if (!res.ok) {
      setError(res.error.message ?? "The channel could not be removed.");
      return;
    }
    toast({ title: `${copy.short} channel removed`, tone: "ok" });
    router.refresh();
  }

  const failures = channel.consecutiveFailures;
  return (
    <li data-testid={`${p}-channel`} data-state={state} className="flex flex-col gap-3 border-b border-rule py-5 first:pt-1 last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span aria-hidden className={clsx("h-[5px] w-6 rounded-full", state === "live" ? LINE[index % LINE.length] : state === "failing" ? "bg-fail" : "bg-rule-2")} />
        <span className="text-body font-semibold text-fg">{channel.channelLabel ?? `${copy.short} channel`}</span>
        <span className="flex-1" />
        {canManage ? (
          <>
            <Switch checked={enabled} onChange={toggle} busy={toggleBusy} disabled={offPlan && !enabled} label={`Send alerts to ${channel.channelLabel ?? "this channel"}`} />
            <span className="text-ui font-medium text-fg-2">{enabled ? "On" : "Off"}</span>
          </>
        ) : null}
      </div>
      <KeyValue
        labelWidth={130}
        rows={[
          [
            "Address",
            <code key="m" data-testid={`${p}-masked`} className="data break-all text-fg">
              {channel.maskedUrl}
            </code>,
          ],
          [
            "Receives",
            <span key="r">
              {kindsSentence(channel.kinds ?? []).replace(/^./, (c) => c.toUpperCase())}, about {clientsSentence(channel.clientIds ?? [], clients)}.
            </span>,
          ],
          ["Last delivered", channel.lastDeliveredAt ? instantLabel(channel.lastDeliveredAt) : <span key="n" className="text-fg-3">nothing delivered yet</span>],
          failures > 0
            ? [
                "Refused",
                <span key="f" className="text-fail">
                  {failures} attempt{failures === 1 ? "" : "s"} in a row{channel.lastError ? `: ${channel.lastError}` : ""}
                </span>,
              ]
            : null,
        ]}
      />
      {failures > 0 && !offPlan ? (
        <Notice tone="warn" title={`${copy.name} is refusing the messages`}>
          The address may have been removed or regenerated. Paste the current one with Change; a new address resets the failure count.
        </Notice>
      ) : null}
      <ActionRefusal error={planError} />
      {error ? (
        <p role="alert" className="text-ui font-medium text-fail">
          {error}
        </p>
      ) : null}
      {canManage ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {!offPlan ? (
            <>
              <Button size="sm" variant="secondary" busy={testBusy} busyLabel="Sending a test message" onClick={sendTest} disabled={!enabled} data-testid={`${p}-test`}>
                Send test message
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing((v) => !v)} data-testid={`${p}-route-edit`}>
                {editing ? "Close" : "Change"}
              </Button>
            </>
          ) : null}
          <Button size="sm" variant="danger-quiet" onClick={() => setRemoveOpen(true)} data-testid={`${p}-remove`}>
            Remove
          </Button>
          {/* At least 14rem, so on a phone it takes its own line rather than a
              one-word column beside the buttons (session 19, 390 px). */}
          <p className="min-w-[14rem] flex-1 text-meta text-fg-3" data-testid={`${p}-test-result`}>
            {testResult ?? (enabled ? "A test is the only way to know the channel works before a real alert depends on it." : "Paused: switch it on to send a test.")}
          </p>
        </div>
      ) : null}
      {editing ? (
        <RouteEditor
          copy={copy}
          organizationId={organizationId}
          channel={channel}
          clients={clients}
          onDone={() => {
            setEditing(false);
            router.refresh();
          }}
        />
      ) : null}
      <ConfirmDialog
        open={removeOpen}
        onClose={() => setRemoveOpen(false)}
        onConfirm={remove}
        title={`Remove ${channel.channelLabel ?? "this channel"}?`}
        body={<p>Messages stop going to it at once and the stored address is deleted. Connecting it again needs the address again.</p>}
        confirmLabel="Remove channel"
        busy={removeBusy}
        danger
      />
    </li>
  );
}

/** Kinds: every kind, or chosen ones. */
function KindScope({
  scope,
  onScope,
  chosen,
  onChosen,
  testId,
}: {
  scope: "all" | "some";
  onScope: (s: "all" | "some") => void;
  chosen: string[];
  onChosen: (k: string[]) => void;
  testId: string;
}) {
  return (
    <fieldset className="flex flex-col gap-2.5" data-testid={testId}>
      <legend className="mb-1 text-meta font-semibold text-fg-2">Which messages</legend>
      <div className="flex">
        <Segmented
          label="Which messages"
          size="sm"
          value={scope}
          onChange={onScope}
          options={[
            { value: "all", label: "Every kind" },
            { value: "some", label: "Chosen kinds" },
          ]}
        />
      </div>
      {scope === "all" ? (
        <p className="text-meta text-fg-3">Alerts of every kind, DNS changes and expiry warnings.</p>
      ) : (
        <>
          <div className="grid gap-2 sm:grid-cols-2">
            {CHAT_KINDS.map((k) => (
              <Checkbox
                key={k.id}
                checked={chosen.includes(k.id)}
                onChange={(e) => onChosen(e.target.checked ? [...chosen, k.id] : chosen.filter((x) => x !== k.id))}
                label={k.name}
                hint={k.kind}
                data-testid={`${testId}-${k.id}`}
              />
            ))}
          </div>
          {chosen.length === 0 ? <p className="text-meta font-medium text-fail">Choose at least one kind.</p> : null}
        </>
      )}
    </fieldset>
  );
}

function useRouteChoice(initial: { clientIds?: string[]; kinds?: string[] }) {
  const [clientScope, setClientScope] = useState<"all" | "some">(initial.clientIds?.length ? "some" : "all");
  const [clientIds, setClientIds] = useState<string[]>(initial.clientIds ?? []);
  const [kindScope, setKindScope] = useState<"all" | "some">(initial.kinds?.length ? "some" : "all");
  const [kinds, setKinds] = useState<string[]>(initial.kinds ?? []);
  const valid = (clientScope === "all" || clientIds.length > 0) && (kindScope === "all" || kinds.length > 0);
  return {
    clientScope,
    setClientScope,
    clientIds,
    setClientIds,
    kindScope,
    setKindScope,
    kinds,
    setKinds,
    valid,
    body: { clientIds: clientScope === "all" ? [] : clientIds, kinds: kindScope === "all" ? [] : kinds },
  };
}

function RouteFields({ copy, clients, route }: { copy: ChatCopy; clients: ClientChoice[] | null; route: ReturnType<typeof useRouteChoice> }) {
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <ClientScope
        clients={clients}
        scope={route.clientScope}
        onScope={route.setClientScope}
        chosen={route.clientIds}
        onChosen={route.setClientIds}
        allText="Messages about every client's domains, including clients added later."
        someText="Only messages about these clients' domains go to this channel."
        testId={`${copy.prefix}-client-scope`}
        itemTestId={`${copy.prefix}-client`}
      />
      <KindScope
        scope={route.kindScope}
        onScope={route.setKindScope}
        chosen={route.kinds}
        onChosen={route.setKinds}
        testId={`${copy.prefix}-kind-scope`}
      />
    </div>
  );
}

function RouteEditor({
  copy,
  organizationId,
  channel,
  clients,
  onDone,
}: {
  copy: ChatCopy;
  organizationId: string;
  channel: Channel;
  clients: ClientChoice[] | null;
  onDone: () => void;
}) {
  const route = useRouteChoice(channel);
  const urlInput = useRef<HTMLInputElement | null>(null);
  const [label, setLabel] = useState(channel.channelLabel ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ActionError | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!route.valid || busy) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    const url = urlInput.current?.value.trim() ?? "";
    const res = await updateChatDestination(organizationId, copy.service, channel.id, {
      channelLabel: label.trim() || null,
      ...route.body,
      ...(url ? { webhookUrl: url } : {}),
    });
    setBusy(false);
    if (urlInput.current) urlInput.current.value = "";
    if (!res.ok) {
      if (isPlanRefusal(res.error)) setError(res.error);
      else setMessage(copy.saveError(res.error.code, res.error.message));
      return;
    }
    onDone();
  }

  return (
    <form onSubmit={save} className="flex flex-col gap-5 rounded-sheet border border-rule px-5 py-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Channel name">
          <Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} placeholder={copy.labelPlaceholder} />
        </Field>
        <Field label={`New ${copy.addressLabel.toLowerCase()}`} hint="Optional. Leave empty to keep the current one.">
          <Input ref={urlInput} type="text" mono defaultValue="" autoComplete="off" spellCheck={false} placeholder={copy.placeholder} />
        </Field>
      </div>
      <RouteFields copy={copy} clients={clients} route={route} />
      <ActionRefusal error={error} />
      {message ? (
        <p role="alert" className="text-ui font-medium text-fail">
          {message}
        </p>
      ) : null}
      <div>
        <Button type="submit" variant="primary" busy={busy} busyLabel="Saving the channel" disabled={!route.valid}>
          Save changes
        </Button>
      </div>
    </form>
  );
}

function AddChannel({
  copy,
  organizationId,
  clients,
  canManage,
  first,
  full,
}: {
  copy: ChatCopy;
  organizationId: string;
  clients: ClientChoice[] | null;
  canManage: boolean;
  first: boolean;
  full: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const p = copy.prefix;
  const form = useRef<HTMLFormElement | null>(null);
  const urlInput = useRef<HTMLInputElement | null>(null);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [planError, setPlanError] = useState<ActionError | null>(null);
  const route = useRouteChoice({});

  async function save(e: FormEvent) {
    e.preventDefault();
    if (busy || !route.valid) return;
    const webhookUrl = urlInput.current?.value.trim() ?? "";
    setBusy(true);
    setError(null);
    setPlanError(null);
    const res = await createChatDestination(organizationId, copy.service, { webhookUrl, channelLabel: label.trim() || null, ...route.body });
    setBusy(false);
    // The address leaves the page whatever happened: a refused one is pasted again.
    if (urlInput.current) urlInput.current.value = "";
    if (!res.ok) {
      if (isPlanRefusal(res.error)) setPlanError(res.error);
      else setError(copy.saveError(res.error.code, res.error.message));
      return;
    }
    form.current?.reset();
    setLabel("");
    toast({
      title: `${copy.short} channel added`,
      body: `${res.data.channelLabel ?? "The channel"} receives ${kindsSentence(res.data.kinds ?? [])} from the next one raised. Send a test message to be sure.`,
      tone: "ok",
    });
    router.refresh();
  }

  return (
    <div className="grid gap-x-12 gap-y-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,17rem)]">
      <Panel
        id={`${p}-set`}
        title={first ? "Connect a channel" : "Add another channel"}
        why="Route it to every client or to chosen ones, and to every kind of message or chosen kinds: a channel per client, or DNS changes to one channel and spoofing to another."
      >
        {copy.intro ? <div className="flex flex-col gap-2 text-ui text-fg-2">{copy.intro}</div> : null}
        {!canManage ? (
          <p className="text-ui text-fg-2">An owner or admin can connect or change {copy.name} channels.</p>
        ) : full ? (
          <p className="text-ui text-fg-2">This workspace holds 20 {copy.short} channels, the most it can. Remove one to add another.</p>
        ) : (
          <form ref={form} onSubmit={save} className="mt-2 grid max-w-[720px] gap-5">
            <Field label={copy.addressLabel} hint={copy.addressHint}>
              <Input
                ref={urlInput}
                type="text"
                mono
                name="webhookUrl"
                defaultValue=""
                required
                placeholder={copy.placeholder}
                autoComplete="off"
                spellCheck={false}
                data-testid={`${p}-webhook`}
              />
            </Field>
            <Field label="Channel name" hint={`For your reference on this page. ${copy.short} decides the channel from the address.`}>
              <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={copy.labelPlaceholder} maxLength={80} data-testid={`${p}-label`} />
            </Field>
            <RouteFields copy={copy} clients={clients} route={route} />
            <ActionRefusal error={planError} />
            {error ? (
              <p role="alert" data-testid={`${p}-error`} className="text-ui font-medium text-fail">
                {error}
              </p>
            ) : null}
            <div>
              <Button type="submit" variant="primary" busy={busy} busyLabel={`Saving the ${copy.short} channel`} disabled={!route.valid} data-testid={`${p}-save`}>
                {first ? `Connect ${copy.short}` : "Add channel"}
              </Button>
            </div>
          </form>
        )}
      </Panel>
      <SetupSteps title={copy.stepsTitle} done={!first} className="lg:pt-1" steps={copy.steps} />
    </div>
  );
}
