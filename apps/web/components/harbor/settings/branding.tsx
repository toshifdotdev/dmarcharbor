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
 * Test hooks: domain-verified, domain-unverified.
 */

import { useRouter } from "next/navigation";
import { useMemo, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { chartBrandVars, contrastInk, contrastRatio, HEX } from "@/lib/brand-vars";
import type { FeatureStatus } from "@/lib/entitlements";
import { patchBranding, setCustomDomain, uploadLogo, verifyCustomDomain, type CustomDomainInstructions } from "@/lib/ops-client";
import { PierMark } from "@/components/mark";
import { ActionRefusal, type ActionError } from "@/components/harbor/plan-refusal";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DnsRecord } from "@/components/ui/copy";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { UpgradeNotice } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { Panel } from "./parts";

const PAPER = "#f3f5f7";

function Ratio({ label, value }: { label: string; value: number | null }) {
  if (value === null) return null;
  const ok = value >= 4.5;
  return (
    <span className={ok ? "text-meta text-fg-3" : "text-meta font-semibold text-warn"}>
      {label}: <span className="tnum">{value.toFixed(1)}:1</span> {ok ? "readable" : "too faint for small text (aim for 4.5:1)"}
    </span>
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

export function BrandingBoard({
  organizationId,
  workspaceName,
  primary: savedPrimary,
  ink: savedInk,
  logoUrl,
  customDomain,
  customDomainVerified,
  whitelabel,
  logoUpload,
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
  whitelabel: FeatureStatus;
  logoUpload: FeatureStatus;
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

  const p = HEX.test(primary) ? primary : null;
  const i = HEX.test(ink) ? ink : null;
  const vars = useMemo(() => chartBrandVars(p, i), [p, i]);
  const effectiveInk = p ? (i ?? contrastInk(p)) : null;
  const dirty = (primary || null) !== (savedPrimary ?? null) || (ink || null) !== (savedInk ?? null);
  const coloursValid = (primary === "" || HEX.test(primary)) && (ink === "" || HEX.test(ink));
  const editable = canManage && whitelabel !== false;
  const domainFeature = customDomainFeature === undefined ? whitelabel : customDomainFeature;
  const domainEditable = canManage && domainFeature !== false;

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
          message="Your logo and colours are not included in this workspace's plan."
          feature="branding.whitelabel"
          context="Clients see DMARC Harbor's colours until it is. Anything saved here before is kept, and returns when the plan includes it."
        />
      ) : null}

      <Panel
        id="wl-preview"
        title="What a client sees"
        why="The client portal always carries this. Share links, Trust Centers and the sign-in page carry it on your verified custom domain."
        aside="Preview with sample content"
      >
        <div
          data-harbor
          // data-harbor re-declares the accent-derived tokens against these
          // colours; its page-root min-height (unlayered, so it beats
          // utilities) is undone inline.
          style={{ ...(vars as CSSProperties), minHeight: 0, zIndex: "auto" }}
          className="overflow-hidden rounded-ctl border border-rule-2 bg-paper shadow-[0_1px_2px_rgb(18_26_34/0.06)]"
          aria-label="Preview of a client-facing page"
          role="img"
        >
          <div className="flex items-center gap-3 border-b border-rule px-4 py-2.5">
            <span className="flex items-center gap-2 text-act">
              {logoUrl ? <img src={logoUrl} alt="" className="h-6 w-auto" /> : p ? null : <PierMark size={22} />}
              <span className="wide text-ui font-bold text-fg">{workspaceName}</span>
            </span>
            <span aria-hidden className="h-4 w-px bg-rule-2" />
            <span className="legend">Client reports</span>
            <span className="ml-auto text-meta text-fg-3">contact@client.example</span>
          </div>
          <div className="grid gap-4 px-4 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
            <div>
              <p className="text-h3 font-bold text-fg">Example Freight</p>
              <ul className="mt-2 flex flex-col text-ui">
                <li className="flex items-baseline gap-2 border-t border-rule py-1.5">
                  <span aria-hidden className="size-2 bg-ok" />
                  <span className="data text-fg">example-freight.example</span>
                  <span className="text-fg-2">Protected</span>
                </li>
                <li className="flex items-baseline gap-2 border-y border-rule py-1.5">
                  <span aria-hidden className="size-2.5 rounded-full border-2 border-warn-mark" />
                  <span className="data text-fg">mail.example-freight.example</span>
                  <span className="text-fg-2">Needs attention</span>
                  <span className="link ml-auto text-meta">What to do</span>
                </li>
              </ul>
            </div>
            <span className="inline-flex h-8 items-center justify-center rounded-ctl bg-[var(--hb-primary,var(--color-fg))] px-3 text-ui font-semibold text-[var(--hb-primary-ink,#fff)]">
              Forward to your IT team
            </span>
          </div>
        </div>
        <div className="flex flex-wrap gap-x-5 gap-y-1">
          <Ratio label="Button text on the brand colour" value={p && effectiveInk ? contrastRatio(p, effectiveInk) : null} />
          <Ratio label="Links on the page" value={p ? contrastRatio(p, PAPER) : null} />
          {!p ? <span className="text-meta text-fg-3">No brand colour set: clients see the default.</span> : null}
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
              fallback="#1f56b5"
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
                    className="text-meta text-fg-2 file:mr-3 file:h-8 file:cursor-pointer file:rounded-ctl file:border file:border-rule-2 file:bg-paper-2 file:px-3 file:text-ui file:font-semibold file:text-fg hover:file:border-fg-3"
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
        id="wl-domain"
        title="Custom domain"
        why="Client links open on your own address, such as reports.youragency.example, instead of ours. A TXT record proves the domain is yours; the hostname must also point at this service for the pages to open on it."
        aside={
          customDomain ? (
            domainFeature === false ? (
              <Badge tone="warn">Kept, not used on this plan</Badge>
            ) : customDomainVerified ? (
              <span data-testid="domain-verified">
                <Badge tone="ok">Verified, serving your brand</Badge>
              </span>
            ) : (
              <span data-testid="domain-unverified">
                <Badge tone="warn">Not verified yet: not live</Badge>
              </span>
            )
          ) : null
        }
      >
        {customDomain ? (
          <p className="text-ui">
            <code className="data text-body font-semibold text-fg">{customDomain}</code>
            {customDomainVerified ? null : (
              <span className="ml-2 text-fg-2">Clients still see the default address until the record below is found.</span>
            )}
          </p>
        ) : null}

        {record?.verificationHost && record.verificationValue ? (
          <div className="flex flex-col gap-2 rounded-ctl border border-act/40 bg-paper-2 px-4 py-3.5 [animation:hb-rise_240ms_ease-out]">
            <p className="legend text-act!">Shown once</p>
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
                : "Your logo and colours already appear on client pages served from our address."
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
              <Button variant="ghost" className="text-fail hover:text-fail" onClick={() => setRemoveOpen(true)}>
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
    </div>
  );
}
