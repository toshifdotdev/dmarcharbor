"use client";

/**
 * branding.tsx — white label: what a client sees when they open anything you
 * send them.
 *
 * Built around a preview, because the decision is visual and the cost of a
 * wrong one lands in front of a client: a colour that makes button text
 * unreadable, a logo that looks broken, a custom domain that does not open.
 * The preview uses the same arithmetic the real pages do (lib/brand-vars.ts),
 * and the contrast of each colour pair is measured and stated, not guessed.
 *
 * Logo and colours need branding.whitelabel and branding.logoUpload (Harbor
 * and up). The custom domain needs branding.customDomain (Admiralty), so it
 * has its own plan notice and its own editable flag; a domain kept after a
 * downgrade can still be removed.
 *
 * Custom domain: the API mints a new TXT token on every set and returns it
 * only in that response, so the record is shown once with that warning, and
 * an unverified domain can be issued a fresh record instead of a dead end.
 *
 * The custom domain is drawn as three stations (choose the hostname, publish
 * the TXT record, client pages open on it), travelled green up to where the
 * domain is, planned beyond, so "verified" and "not verified yet" are a place
 * on a line as well as a word.
 *
 * Client contact (white label, Harbor and up): a support email and page the
 * agency publishes to its clients. They appear in the portal's foot and under
 * the sign-in form on the agency's domain, and the email is the Reply-To on
 * client mail. The API checks both and says why in a 400.
 *
 * Email from your domain (Admiralty, the custom domain entitlement): the
 * agency names an address on its own domain, publishes the DKIM and SPF
 * records the email provider returns, and checks them. The provider checks
 * asynchronously, so "Check records" can answer "not seen yet" for minutes;
 * until it says verified, client email keeps coming from the shared address
 * with the agency's name. Drawn as the same three stations as the custom
 * domain. A kept address can be removed on any plan.
 *
 * Test hooks: domain-verified, domain-unverified; wl-contact, wl-support-email,
 * wl-support-url, wl-contact-save; wl-sending, wl-sending-address,
 * wl-sending-claim, wl-sending-records, wl-sending-record-<index>,
 * wl-sending-check, wl-sending-remove, sending-verified, sending-waiting,
 * sending-failed.
 */

import { useRouter } from "next/navigation";
import { useMemo, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { chartBrandVars, contrastInk, contrastRatio, HEX } from "@/lib/brand-vars";
import type { FeatureStatus } from "@/lib/entitlements";
import {
  checkSendingDomain,
  patchBranding,
  setCustomDomain,
  setSendingAddress,
  uploadLogo,
  verifyCustomDomain,
  type CustomDomainInstructions,
} from "@/lib/ops-client";
import { sendingCheckNotice, sendingDomainOf, sendingDomainPhase, sendingRecordPhase, type SendingPhase } from "@/lib/sending-domain";
import type { SendingDomainRecord, SendingDomainState } from "@/lib/types";
import { PierMark } from "@/components/mark";
import { ActionRefusal, type ActionError } from "@/components/harbor/plan-refusal";
import { Button, fileInputClass } from "@/components/ui/button";
import { DnsRecord } from "@/components/ui/copy";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { UpgradeNotice } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { Panel, StateMark, StateWord, StepLine } from "./parts";

/** The ground every client page sits on (--color-paper), as a hex because the
 *  contrast arithmetic needs one. */
const PAPER = "#ffffff";

function Ratio({ label, value }: { label: string; value: number | null }) {
  if (value === null) return null;
  const ok = value >= 4.5;
  return (
    <span className="inline-flex items-center gap-2 text-meta">
      <StateMark shape={ok ? "square" : "ring"} tone={ok ? "ok" : "warn"} size={9} />
      <span className="text-fg-2">{label}</span>
      <span className="tnum font-semibold text-fg">{value.toFixed(1)}:1</span>
      <span className={ok ? "text-ok" : "font-semibold text-warn"}>{ok ? "readable" : "too faint for small text, aim for 4.5:1"}</span>
    </span>
  );
}

/** A domain row in the preview, the way the client portal lists one. */
function PreviewRow({ name, verdict, meaning, tone }: { name: string; verdict: string; meaning: string; tone: "ok" | "fail" }) {
  return (
    <li
      className={`grid gap-x-6 gap-y-1 border-b border-rule py-3 pl-4 pr-1 last:border-b-0 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)_auto] ${
        tone === "ok" ? "shadow-[inset_3px_0_0_var(--color-ok)]" : "shadow-[inset_3px_0_0_var(--color-fail)]"
      }`}
    >
      <span className="data break-all text-ui font-semibold text-fg">{name}</span>
      <span className="min-w-0">
        <StateWord shape={tone === "ok" ? "square" : "diamond"} tone={tone} size="meta">
          {verdict}
        </StateWord>
        <span className="mt-0.5 block text-meta text-fg-2">{meaning}</span>
      </span>
      <span className="self-center text-meta font-semibold text-act">See the evidence →</span>
    </li>
  );
}

function ColourField({
  label,
  hint,
  value,
  onChange,
  fallback,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (v: string) => void;
  fallback: string;
}) {
  const valid = value === "" || HEX.test(value);
  return (
    <Field label={label} hint={hint} error={valid ? undefined : "Use six hex digits, like #1a2b3c."}>
      <span className="flex items-center gap-2">
        <input
          type="color"
          aria-label={`${label}, picker`}
          value={HEX.test(value) ? value : fallback}
          onChange={(e) => onChange(e.target.value)}
          className="h-8 w-10 shrink-0 cursor-pointer rounded-ctl border border-rule-2 bg-paper-2 p-0.5"
        />
        <Input mono value={value} onChange={(e) => onChange(e.target.value.trim().toLowerCase())} placeholder={fallback} maxLength={7} className="max-w-[140px]" />
      </span>
    </Field>
  );
}

/** The sending domain's overall state, as a word with its shape. */
function SendingStateWord({ phase }: { phase: SendingPhase }) {
  if (phase === "verified") {
    return (
      <span data-testid="sending-verified">
        <StateWord shape="square" tone="ok">
          Verified
        </StateWord>
      </span>
    );
  }
  if (phase === "failed") {
    return (
      <span data-testid="sending-failed">
        <StateWord shape="diamond" tone="fail">
          Failed
        </StateWord>
      </span>
    );
  }
  return (
    <span data-testid="sending-waiting">
      <StateWord shape="ring" tone="warn">
        Waiting for DNS
      </StateWord>
    </span>
  );
}

/** One record to publish: what it is for, the provider's view of it, and the record itself. */
function SendingRecordRow({ record, index }: { record: SendingDomainRecord; index: number }) {
  const phase = sendingRecordPhase(record.status);
  return (
    <div data-testid={`wl-sending-record-${index}`} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="text-ui">
          <span className="font-bold text-fg">{record.record}</span>
          <span className="text-fg-3"> {record.type} record</span>
        </p>
        {phase === "verified" ? (
          <StateWord shape="square" tone="ok" size="meta">
            Seen by your email provider
          </StateWord>
        ) : phase === "failed" ? (
          <StateWord shape="diamond" tone="fail" size="meta">
            Failed
          </StateWord>
        ) : (
          <StateWord shape="ring" tone="warn" size="meta">
            Not seen yet
          </StateWord>
        )}
      </div>
      <DnsRecord
        type={record.type}
        host={record.name}
        value={record.value}
        note={
          record.priority !== null ? (
            <>
              Priority <span className="tnum font-semibold text-fg-2">{record.priority}</span>. Most DNS forms have a field of
              its own for it.
            </>
          ) : undefined
        }
      />
    </div>
  );
}

const NO_SENDING: SendingDomainState = { sendingAddress: null, status: null, records: [], verified: false };

export function BrandingBoard({
  organizationId,
  workspaceName,
  primary: savedPrimary,
  ink: savedInk,
  logoUrl,
  customDomain,
  customDomainVerified,
  supportEmail: savedSupportEmail = null,
  supportUrl: savedSupportUrl = null,
  sending: savedSending = NO_SENDING,
  whitelabel,
  logoUpload,
  logoStorage = true,
  customDomainFeature,
  canManage,
}: {
  organizationId: string;
  workspaceName: string;
  primary: string | null;
  ink: string | null;
  /** The resolved logo: only a platform-served object, only under licence. */
  logoUrl: string | null;
  customDomain: string | null;
  customDomainVerified: boolean;
  /** The stored client contact. */
  supportEmail?: string | null;
  supportUrl?: string | null;
  /** The stored own sending address and its records, verified or not. */
  sending?: SendingDomainState;
  whitelabel: FeatureStatus;
  logoUpload: FeatureStatus;
  /** False when this deployment has no logo storage: upload is not offered. */
  logoStorage?: boolean;
  /** Admiralty only. Absent from an older API: then the white label flag decides, as before. */
  customDomainFeature?: FeatureStatus;
  canManage: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [primary, setPrimary] = useState(savedPrimary ?? "");
  const [ink, setInk] = useState(savedInk ?? "");
  const [colourBusy, setColourBusy] = useState(false);
  const [colourError, setColourError] = useState<ActionError | null>(null);

  const fileInput = useRef<HTMLInputElement | null>(null);
  const [logoBusy, setLogoBusy] = useState(false);
  const [logoError, setLogoError] = useState<ActionError | null>(null);

  const [domain, setDomain] = useState("");
  const [record, setRecord] = useState<CustomDomainInstructions | null>(null);
  const [domainBusy, setDomainBusy] = useState<"set" | "verify" | "remove" | null>(null);
  const [domainError, setDomainError] = useState<ActionError | null>(null);
  const [verifyNote, setVerifyNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);

  // The contact as last saved, kept here because the API normalises what it
  // stores (a lowercased domain, a trailing slash) and the form compares to that.
  const [contactSaved, setContactSaved] = useState({ email: savedSupportEmail ?? "", url: savedSupportUrl ?? "" });
  const [supportEmail, setSupportEmail] = useState(savedSupportEmail ?? "");
  const [supportUrl, setSupportUrl] = useState(savedSupportUrl ?? "");
  const [contactBusy, setContactBusy] = useState(false);
  const [contactError, setContactError] = useState<ActionError | null>(null);

  // Started from the stored row and replaced by each answer, so a claim or a
  // check shows at once rather than after the refresh.
  const [sending, setSending] = useState<SendingDomainState>(savedSending);
  const [sendingInput, setSendingInput] = useState("");
  const [sendingBusy, setSendingBusy] = useState<"set" | "check" | "remove" | null>(null);
  const [sendingError, setSendingError] = useState<ActionError | null>(null);
  const [sendingNote, setSendingNote] = useState<{ tone: "info" | "ok" | "warn" | "fail"; text: string } | null>(null);
  const [sendingRemoveOpen, setSendingRemoveOpen] = useState(false);

  const p = HEX.test(primary) ? primary : null;
  const i = HEX.test(ink) ? ink : null;
  const vars = useMemo(() => chartBrandVars(p, i), [p, i]);
  const effectiveInk = p ? (i ?? contrastInk(p)) : null;
  const dirty = (primary || null) !== (savedPrimary ?? null) || (ink || null) !== (savedInk ?? null);
  const coloursValid = (primary === "" || HEX.test(primary)) && (ink === "" || HEX.test(ink));
  const editable = canManage && whitelabel !== false;
  const domainFeature = customDomainFeature === undefined ? whitelabel : customDomainFeature;
  const domainEditable = canManage && domainFeature !== false;
  const contactDirty = supportEmail.trim() !== contactSaved.email || supportUrl.trim() !== contactSaved.url;
  const sendingPhase = sending.sendingAddress ? sendingDomainPhase(sending) : null;
  const sendingDomain = sendingDomainOf(sending.sendingAddress);

  async function saveContact(e: FormEvent) {
    e.preventDefault();
    if (!contactDirty || contactBusy) return;
    const email = supportEmail.trim();
    const url = supportUrl.trim();
    setContactBusy(true);
    setContactError(null);
    // An empty field clears the value: the API takes null for that.
    const res = await patchBranding(organizationId, { brandSupportEmail: email || null, brandSupportUrl: url || null });
    setContactBusy(false);
    if (!res.ok) {
      setContactError(res.error);
      return;
    }
    // The stored form when the API returns it (only under white label), else what was sent.
    const stored = res.data?.branded
      ? { email: res.data.supportEmail ?? "", url: res.data.supportUrl ?? "" }
      : { email, url };
    setContactSaved(stored);
    setSupportEmail(stored.email);
    setSupportUrl(stored.url);
    toast(
      stored.email || stored.url
        ? {
            title: "Client contact saved",
            body: customDomainVerified
              ? "Clients see it in the portal at once, and on your sign-in page within ten minutes."
              : "Clients see it the next time they open the portal.",
            tone: "ok",
          }
        : { title: "Client contact removed", body: "Clients no longer see a support address or page.", tone: "ok" },
    );
    router.refresh();
  }

  async function claimSending(e: FormEvent) {
    e.preventDefault();
    const address = sendingInput.trim();
    if (!address || sendingBusy) return;
    setSendingBusy("set");
    setSendingError(null);
    setSendingNote(null);
    const res = await setSendingAddress(organizationId, address);
    setSendingBusy(null);
    if (!res.ok) {
      setSendingError(res.error);
      return;
    }
    setSending(res.data);
    setSendingInput("");
    if (res.data.notice) setSendingNote({ tone: "info", text: res.data.notice });
    router.refresh();
  }

  async function checkSending() {
    if (sendingBusy) return;
    setSendingBusy("check");
    setSendingError(null);
    setSendingNote(null);
    const res = await checkSendingDomain(organizationId);
    setSendingBusy(null);
    if (!res.ok) {
      setSendingError(res.error);
      return;
    }
    setSending(res.data);
    setSendingNote(sendingCheckNotice(res.data));
    router.refresh();
  }

  async function removeSending() {
    setSendingBusy("remove");
    setSendingError(null);
    const res = await setSendingAddress(organizationId, null);
    setSendingBusy(null);
    setSendingRemoveOpen(false);
    if (!res.ok) {
      setSendingError(res.error);
      return;
    }
    setSending(NO_SENDING);
    setSendingNote(null);
    toast({
      title: "Sending address removed",
      body: res.data.notice ?? "Client email comes from our shared address with your agency's name again.",
      tone: "ok",
    });
    router.refresh();
  }

  async function saveColours(e: FormEvent) {
    e.preventDefault();
    if (!coloursValid || colourBusy) return;
    setColourBusy(true);
    setColourError(null);
    const res = await patchBranding(organizationId, { brandPrimaryColor: p, brandAccentColor: i });
    setColourBusy(false);
    if (!res.ok) {
      setColourError(res.error);
      return;
    }
    toast({ title: "Colours saved", body: "Clients see them on their next page load.", tone: "ok" });
    router.refresh();
  }

  async function upload(file: File | undefined) {
    if (!file) return;
    setLogoBusy(true);
    setLogoError(null);
    const res = await uploadLogo(organizationId, file);
    setLogoBusy(false);
    if (fileInput.current) fileInput.current.value = "";
    if (!res.ok) {
      setLogoError(res.error);
      return;
    }
    toast({ title: "Logo uploaded", tone: "ok" });
    router.refresh();
  }

  async function removeLogo() {
    setLogoBusy(true);
    setLogoError(null);
    const res = await patchBranding(organizationId, { logoUrl: null });
    setLogoBusy(false);
    if (!res.ok) {
      setLogoError(res.error);
      return;
    }
    router.refresh();
  }

  async function claim(host: string) {
    setDomainBusy("set");
    setDomainError(null);
    setVerifyNote(null);
    const res = await setCustomDomain(organizationId, host);
    setDomainBusy(null);
    if (!res.ok) {
      setDomainError(res.error);
      return;
    }
    setRecord(res.data);
    setDomain("");
    router.refresh();
  }

  async function verify() {
    setDomainBusy("verify");
    setDomainError(null);
    setVerifyNote(null);
    const res = await verifyCustomDomain(organizationId);
    setDomainBusy(null);
    if (!res.ok) {
      setDomainError(res.error);
      return;
    }
    setVerifyNote(
      res.data.verified
        ? { ok: true, text: "The record is there: the domain is verified and serves your brand." }
        : {
            ok: false,
            text: `The record was not found yet${res.data.lookupStatus ? ` (${res.data.lookupStatus.toLowerCase().replace(/_/g, " ")})` : ""}. DNS changes can take minutes to hours to be visible; check again later.`,
          },
    );
    if (res.data.verified) setRecord(null);
    router.refresh();
  }

  async function removeDomain() {
    setDomainBusy("remove");
    const res = await setCustomDomain(organizationId, null);
    setDomainBusy(null);
    setRemoveOpen(false);
    if (!res.ok) {
      setDomainError(res.error);
      return;
    }
    setRecord(null);
    setVerifyNote(null);
    toast({ title: "Custom domain removed", tone: "ok" });
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-10">
      {whitelabel === false ? (
        <UpgradeNotice
          message="Your logo, colours and client contact are not included in this workspace's plan."
          feature="branding.whitelabel"
          context="Clients see the default colours and no support contact until it is. Anything saved here before is kept, and returns when the plan includes it."
        />
      ) : null}

      <Panel
        id="wl-preview"
        title="What a client sees"
        why="The client portal always carries your name, and your logo and colours once white label is on, as do monthly reports, Trust Centers, prospect reports and the emails clients receive. With a verified custom domain, every page a client opens is on your address, sign-in and share links included."
      >
        <figure className="flex flex-col gap-3">
          <div
            data-harbor
            // data-harbor re-declares the accent-derived tokens against these
            // colours; its page-root min-height (unlayered, so it beats
            // utilities) is undone inline.
            style={{ ...(vars as CSSProperties), minHeight: 0, zIndex: "auto" }}
            className="overflow-hidden rounded-sheet border border-rule-2 bg-paper"
            aria-label={`Preview of the client portal under ${workspaceName}, with sample content`}
            role="img"
          >
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-rule px-5 py-3">
              <span className={`flex items-center gap-2.5 ${p ? "text-act" : "text-fg"}`}>
                {logoUrl ? <img src={logoUrl} alt="" className="h-[26px] w-auto" /> : p ? null : <PierMark size={22} />}
                <span className="text-body font-bold text-fg">{workspaceName}</span>
              </span>
              <span aria-hidden className="hidden h-5 w-px bg-rule-2 sm:block" />
              <span className="hidden text-meta font-semibold text-fg-2 sm:inline">Client reports</span>
              <span className="data ml-auto hidden text-meta text-fg-3 md:inline">it@corriwick.example</span>
            </div>
            <div className="flex flex-col gap-4 px-5 pb-5 pt-5">
              <div>
                <p className="text-meta font-semibold text-fg-3">Corriwick Café</p>
                <p className="display mt-1 text-[24px] leading-[1.05] text-fg">Your domains</p>
                <p className="mt-1.5 max-w-[60ch] text-ui text-fg-2">
                  1 of 2 domains needs attention. The rest are listed below with what was observed.
                </p>
              </div>
              <ol className="flex flex-col border-y border-fg">
                <PreviewRow
                  name="mail.corriwick.example"
                  verdict="Someone may be sending email as you"
                  meaning="Forward this report to your provider."
                  tone="fail"
                />
                <PreviewRow name="corriwick.example" verdict="Protected" meaning="Every message reported passed the checks." tone="ok" />
              </ol>
              <div className="flex flex-wrap items-center gap-3">
                <span className="inline-flex h-9 items-center justify-center rounded-full bg-[var(--hb-primary,var(--color-fg))] px-4 text-ui font-semibold text-[var(--hb-primary-ink,var(--color-paper))]">
                  Forward to your IT team
                </span>
                <span className="link text-ui font-semibold">Download the monthly report</span>
              </div>
            </div>
          </div>
          <figcaption className="text-meta text-fg-3">
            Sample client and domains, drawn with the colours in the form below before you save them.
          </figcaption>
        </figure>
        <div className="flex flex-col gap-1.5">
          <Ratio label="Button text on the brand colour" value={p && effectiveInk ? contrastRatio(p, effectiveInk) : null} />
          <Ratio label="Links on the white page" value={p ? contrastRatio(p, PAPER) : null} />
          {!p ? (
            <span className="inline-flex items-center gap-2 text-meta text-fg-3">
              <StateMark shape="closed" size={9} />
              No brand colour set: clients see the default blue links and ink buttons.
            </span>
          ) : null}
        </div>
      </Panel>

      <Panel id="wl-colours" title="Colours">
        <form onSubmit={saveColours} className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-6">
            <ColourField
              label="Brand colour"
              hint="Links, focus rings and primary buttons."
              value={primary}
              onChange={setPrimary}
              fallback="#15171b"
            />
            <ColourField
              label="Text on the brand colour"
              hint="Leave empty to pick black or white, whichever reads better."
              value={ink}
              onChange={setInk}
              fallback={p ? contrastInk(p) : "#ffffff"}
            />
          </div>
          <ActionRefusal error={colourError} />
          {editable ? (
            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" variant="primary" busy={colourBusy} busyLabel="Saving colours" disabled={!dirty || !coloursValid}>
                Save colours
              </Button>
              {dirty ? (
                <button
                  type="button"
                  className="link text-ui"
                  onClick={() => {
                    setPrimary(savedPrimary ?? "");
                    setInk(savedInk ?? "");
                  }}
                >
                  Put back the saved colours
                </button>
              ) : null}
              {(savedPrimary || savedInk) && !dirty ? (
                <button
                  type="button"
                  className="link text-ui"
                  onClick={() => {
                    setPrimary("");
                    setInk("");
                  }}
                >
                  Use the default colours
                </button>
              ) : null}
            </div>
          ) : (
            <p className="text-meta text-fg-3">Try colours here; saving needs {canManage ? "Harbor or above" : "an owner or admin"}.</p>
          )}
        </form>
      </Panel>

      <Panel id="wl-logo" title="Logo" why="SVG, PNG, JPEG or WebP, under 256 KB. A wide logo about 26 pixels high reads best in the header.">
        {logoUpload === false ? (
          <UpgradeNotice message="Logo upload is not included in this workspace's plan." feature="branding.logoUpload" />
        ) : !logoStorage && !logoUrl ? (
          <Notice testId="wl-logo-unavailable" title="Logo upload isn't available on this deployment.">
            No file storage is set up for logos, so an upload would fail. Your name and colours still appear on everything
            your clients see. Whoever runs this deployment can turn logo upload on.
          </Notice>
        ) : (
          <div className="flex flex-wrap items-center gap-4">
            <span className="grid h-14 min-w-[140px] place-items-center rounded-ctl border border-rule bg-paper-2 px-3">
              {logoUrl ? <img src={logoUrl} alt="Your uploaded logo" className="max-h-9 w-auto" /> : <span className="text-meta text-fg-3">No logo</span>}
            </span>
            {canManage ? (
              <>
                <label className="inline-flex">
                  <span className="sr-only">Choose a logo file</span>
                  <input
                    ref={fileInput}
                    type="file"
                    accept="image/svg+xml,image/png,image/jpeg,image/webp"
                    onChange={(e) => upload(e.target.files?.[0])}
                    disabled={logoBusy}
                    className={fileInputClass}
                  />
                </label>
                {logoUrl ? (
                  <Button size="sm" variant="ghost" onClick={removeLogo} busy={logoBusy} busyLabel="Removing the logo">
                    Remove logo
                  </Button>
                ) : null}
              </>
            ) : null}
          </div>
        )}
        <ActionRefusal error={logoError} />
        <p className="text-meta text-fg-3">Moving to a plan without logo upload removes the stored logo.</p>
      </Panel>

      <Panel
        id="wl-contact"
        testId="wl-contact"
        title="Client contact"
        why="Where your clients go with a question. They see it in the portal, and under the sign-in form on your own domain. Replies to the emails they receive go to the support email."
      >
        <form onSubmit={saveContact} noValidate className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-6">
            <Field label="Support email" hint="One address, such as help@youragency.example." className="min-w-[min(100%,300px)] flex-1">
              <Input
                mono
                inputMode="email"
                value={supportEmail}
                onChange={(e) => setSupportEmail(e.target.value)}
                placeholder="help@youragency.example"
                maxLength={254}
                autoComplete="off"
                spellCheck={false}
                disabled={!editable}
                data-testid="wl-support-email"
              />
            </Field>
            <Field label="Support page" hint="A full https address, such as a help desk or contact page." className="min-w-[min(100%,300px)] flex-1">
              <Input
                mono
                inputMode="url"
                value={supportUrl}
                onChange={(e) => setSupportUrl(e.target.value)}
                placeholder="https://youragency.example/help"
                maxLength={500}
                autoComplete="off"
                spellCheck={false}
                disabled={!editable}
                data-testid="wl-support-url"
              />
            </Field>
          </div>
          <ActionRefusal error={contactError} />
          {editable ? (
            <div className="flex flex-wrap items-center gap-3">
              <Button
                type="submit"
                variant="primary"
                busy={contactBusy}
                busyLabel="Saving the client contact"
                disabled={!contactDirty}
                data-testid="wl-contact-save"
              >
                Save contact
              </Button>
              {contactDirty ? (
                <button
                  type="button"
                  className="link text-ui"
                  onClick={() => {
                    setSupportEmail(contactSaved.email);
                    setSupportUrl(contactSaved.url);
                  }}
                >
                  Put back the saved contact
                </button>
              ) : null}
              <span className="text-meta text-fg-3">Empty a field and save to stop showing it.</span>
            </div>
          ) : (
            <p className="text-meta text-fg-3">Changing the contact needs {canManage ? "Harbor or above" : "an owner or admin"}.</p>
          )}
        </form>
      </Panel>

      <Panel
        id="wl-domain"
        title="Custom domain"
        why="Once it is verified, everything a client opens is on your address, such as reports.youragency.example: the portal and its sign-in, share links, Trust Centers, prospect reports, and the links in monthly report and password reset emails. Clients sign in there with email and password, because Google and Microsoft sign-in cannot complete on your domain. A TXT record proves the domain is yours; the hostname must also point at this service for the pages to open on it."
        aside={
          customDomain ? (
            domainFeature === false ? (
              <StateWord shape="half" tone="void">
                Kept, not used on this plan
              </StateWord>
            ) : customDomainVerified ? (
              <span data-testid="domain-verified">
                <StateWord shape="square" tone="ok">
                  Verified, serving your brand
                </StateWord>
              </span>
            ) : (
              <span data-testid="domain-unverified">
                <StateWord shape="ring" tone="warn">
                  Not verified yet: not live
                </StateWord>
              </span>
            )
          ) : (
            <StateWord shape="closed" tone="void">
              Not set up
            </StateWord>
          )
        }
      >
        {domainFeature !== false ? (
          <StepLine
            label="Custom domain setup"
            steps={[
              {
                key: "host",
                title: "Choose the hostname",
                body: customDomain ? <span className="data break-all">{customDomain}</span> : "reports.youragency.example",
                state: customDomain ? "done" : "current",
              },
              {
                key: "txt",
                title: "Publish the TXT record",
                body: customDomainVerified ? "Found" : customDomain ? "Waiting to be found" : "Shown once, when you choose",
                state: customDomainVerified ? "done" : customDomain ? "current" : "planned",
              },
              {
                key: "live",
                title: "Client pages open on it",
                body: customDomainVerified ? "Live, in your brand" : "Not live yet",
                state: customDomainVerified ? "done" : "planned",
              },
            ]}
          />
        ) : null}

        {customDomain ? (
          <p className="text-ui">
            <code className="data text-body font-semibold text-fg">{customDomain}</code>
            {customDomainVerified ? null : (
              <span className="ml-2 text-fg-2">Clients still see the default address until the record below is found.</span>
            )}
          </p>
        ) : null}

        {record?.verificationHost && record.verificationValue ? (
          <div className="flex flex-col gap-3 rounded-sheet border-2 border-fg px-5 py-4">
            <p className="flex items-center gap-2 text-meta font-semibold text-fg">
              <StateMark shape="open" />
              Shown once
            </p>
            <p className="text-ui text-fg-2">
              Publish this TXT record at your DNS host now. The value is not stored anywhere you can read it back: if you lose
              it, issue a new one.
            </p>
            <DnsRecord type="TXT" host={record.verificationHost} zone={record.customDomain ?? undefined} value={record.verificationValue} testId="domain-record" />
          </div>
        ) : null}

        {domainFeature === false ? (
          <UpgradeNotice
            message="Client pages on your own domain are not included in this workspace's plan."
            feature="branding.customDomain"
            context={
              customDomain
                ? "The domain you set up on Admiralty is kept but not used. Remove it below, or upgrade to use it again."
                : "Your logo and colours already appear in the portal and on reports, served from our address."
            }
          />
        ) : null}
        {verifyNote ? <Notice tone={verifyNote.ok ? "ok" : "warn"} title={verifyNote.text} /> : null}
        <ActionRefusal error={domainError} />

        {/* Removing a kept domain works on every plan; claiming and verifying need Admiralty. */}
        {domainEditable || (canManage && customDomain) ? (
          customDomain ? (
            <div className="flex flex-wrap items-center gap-3">
              {!customDomainVerified && domainEditable ? (
                <>
                  <Button variant="primary" onClick={verify} busy={domainBusy === "verify"} busyLabel="Looking up the record">
                    Check the record
                  </Button>
                  <Button onClick={() => claim(customDomain)} busy={domainBusy === "set"} busyLabel="Issuing a new record">
                    Issue a new record
                  </Button>
                </>
              ) : null}
              <Button variant="danger-quiet" onClick={() => setRemoveOpen(true)}>
                Remove custom domain
              </Button>
            </div>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (domain.trim()) void claim(domain.trim());
              }}
              className="flex flex-wrap items-end gap-3"
            >
              <Field label="Hostname" className="min-w-[min(100%,320px)] flex-1">
                <Input mono value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="reports.youragency.example" maxLength={300} autoComplete="off" spellCheck={false} />
              </Field>
              <Button type="submit" variant="primary" busy={domainBusy === "set"} busyLabel="Reserving the domain" disabled={!domain.trim()}>
                Use this domain
              </Button>
            </form>
          )
        ) : null}
      </Panel>

      <Panel
        id="wl-sending"
        testId="wl-sending"
        title="Email from your domain"
        why="The email your clients receive can come from an address on your own domain, such as reports@mail.youragency.example, instead of our shared address with your agency's name. You publish the DKIM and SPF records the email provider needs, then check them here."
        aside={
          sending.sendingAddress && sendingPhase ? (
            domainFeature === false ? (
              <StateWord shape="half" tone="void">
                Kept, not used on this plan
              </StateWord>
            ) : (
              <SendingStateWord phase={sendingPhase} />
            )
          ) : (
            <StateWord shape="closed" tone="void">
              Not set up
            </StateWord>
          )
        }
      >
        {domainFeature !== false ? (
          <StepLine
            label="Sending address setup"
            steps={[
              {
                key: "address",
                title: "Choose the address",
                body: sending.sendingAddress ? <span className="data break-all">{sending.sendingAddress}</span> : "reports@mail.youragency.example",
                state: sending.sendingAddress ? "done" : "current",
              },
              {
                key: "records",
                title: "Publish the DKIM and SPF records",
                body:
                  sendingPhase === "verified"
                    ? "Seen by your email provider"
                    : sendingPhase === "failed"
                      ? "Not found as shown"
                      : sending.sendingAddress
                        ? "Waiting to be seen"
                        : "Shown when you choose",
                state: sendingPhase === "verified" ? "done" : sending.sendingAddress ? "current" : "planned",
              },
              {
                key: "live",
                title: "Client email comes from it",
                body: sendingPhase === "verified" ? "Live, with your agency's name" : "Not yet: our shared address with your name",
                state: sendingPhase === "verified" ? "done" : "planned",
              },
            ]}
          />
        ) : null}

        {sending.sendingAddress ? (
          <p className="text-ui">
            <code className="data text-body font-semibold text-fg">{sending.sendingAddress}</code>
            <span className="ml-2 text-fg-2">
              {sendingPhase === "verified" && domainFeature !== false
                ? "Client email comes from this address, with your agency's name. If the records are removed later, it goes back to our shared address."
                : "Until it is verified, client email comes from our shared address with your agency's name."}
            </span>
          </p>
        ) : null}

        {sending.sendingAddress && sending.records.length > 0 ? (
          <div data-testid="wl-sending-records" className="flex flex-col gap-5">
            <p className="text-ui text-fg-2">
              Publish {sending.records.length === 1 ? "this record" : `these ${sending.records.length} records`} in the DNS for{" "}
              {sendingDomain ? <code className="data text-fg">{sendingDomain}</code> : "the address's domain"} exactly as shown,
              then check them. Your email provider can take a few minutes to see them.
            </p>
            {sending.records.map((record, index) => (
              <SendingRecordRow key={`${record.type}-${record.name}-${index}`} record={record} index={index} />
            ))}
          </div>
        ) : null}

        {domainFeature === false ? (
          <UpgradeNotice
            message="Sending client email from your own address is not included in this workspace's plan."
            feature="branding.customDomain"
            context={
              sending.sendingAddress
                ? "The address you set up on Admiralty is kept but not used: client email comes from our shared address with your agency's name. Remove it below, or upgrade to use it again."
                : "Client email comes from our shared address with your agency's name."
            }
          />
        ) : null}
        {sendingNote ? <Notice tone={sendingNote.tone} title={sendingNote.text} testId="wl-sending-note" /> : null}
        <ActionRefusal error={sendingError} />

        {/* Removing a kept address works on every plan; claiming and checking need Admiralty. */}
        {domainEditable || (canManage && sending.sendingAddress) ? (
          sending.sendingAddress ? (
            <div className="flex flex-wrap items-center gap-3">
              {domainEditable ? (
                <Button
                  variant={sendingPhase === "verified" ? "secondary" : "primary"}
                  onClick={checkSending}
                  busy={sendingBusy === "check"}
                  busyLabel="Asking your email provider"
                  data-testid="wl-sending-check"
                >
                  Check records
                </Button>
              ) : null}
              <Button variant="danger-quiet" onClick={() => setSendingRemoveOpen(true)} data-testid="wl-sending-remove">
                Remove sending address
              </Button>
            </div>
          ) : (
            <form onSubmit={claimSending} noValidate className="flex flex-col gap-2">
              <div className="flex flex-wrap items-end gap-3">
                <Field label="Send client email from" className="min-w-[min(100%,320px)] flex-1">
                  <Input
                    mono
                    inputMode="email"
                    value={sendingInput}
                    onChange={(e) => setSendingInput(e.target.value)}
                    placeholder="reports@mail.youragency.example"
                    maxLength={320}
                    autoComplete="off"
                    spellCheck={false}
                    data-testid="wl-sending-address"
                  />
                </Field>
                <Button
                  type="submit"
                  variant="primary"
                  busy={sendingBusy === "set"}
                  busyLabel="Adding the address"
                  disabled={!sendingInput.trim()}
                  data-testid="wl-sending-claim"
                >
                  Use this address
                </Button>
              </div>
              <p className="text-meta text-fg-3">
                Use a subdomain such as <code className="data text-fg-2">mail.youragency.example</code>, so the records you
                publish never touch the mail your main domain sends and receives.
              </p>
            </form>
          )
        ) : null}
      </Panel>

      <ConfirmDialog
        open={removeOpen}
        onClose={() => setRemoveOpen(false)}
        onConfirm={removeDomain}
        title={`Stop using ${customDomain ?? "the custom domain"}?`}
        body={
          <p>
            Links clients already have on that address stop showing your brand. Using it again needs a new TXT record and a
            fresh verification.
          </p>
        }
        confirmLabel="Remove custom domain"
        busy={domainBusy === "remove"}
        danger
      />

      <ConfirmDialog
        open={sendingRemoveOpen}
        onClose={() => setSendingRemoveOpen(false)}
        onConfirm={removeSending}
        title={`Stop sending from ${sending.sendingAddress ?? "your address"}?`}
        body={
          <p>
            Client email switches back to our shared address with your agency&rsquo;s name. Using this address again means
            publishing new records and checking them.
          </p>
        }
        confirmLabel="Remove sending address"
        busy={sendingBusy === "remove"}
        danger
        testId="wl-sending-remove"
      />
    </div>
  );
}
