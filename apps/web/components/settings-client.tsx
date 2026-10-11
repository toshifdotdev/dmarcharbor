"use client";

/**
 * settings-client.tsx — white label, report mailbox, SSO.
 *
 * Logo upload is the three-step flow: request presigned URL (contentType +
 * byteSize), PUT the file, confirm with the objectKey the API returned. The UI
 * never constructs or rewrites an objectKey — an objectKey outside this
 * workspace's prefix is rejected server-side. A typed logo URL is NEVER
 * rendered anywhere: user-entered URLs are filtered out of client-facing
 * responses server-side, and rendering one would be a security bug.
 *
 * Mailbox: ports 993, 143, 2525 only (the API refuses others). The password is
 * write-only — it is sent once and never held in component state afterwards.
 *
 * SSO: allowedEmailDomains cannot be empty when provisioning is JIT (the API
 * refuses it), so the constraint is shown BEFORE save. defaultRole offers
 * analyst / viewer / admin only — never owner, which the API does not accept.
 * The provider secret is write-only; nothing here expects to read it back.
 * The callback URL shown to the operator comes from the connection itself.
 */

import { ActionButton } from "@/components/action-button";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { pollReportInboxNow } from "@/lib/notifications-client";
import { EntitlementNotice } from "@/components/entitlement-gate";
import {
  createSsoConnection,
  patchBranding,
  removeReportInbox,
  removeSsoConnection,
  setCustomDomain,
  setReportInbox,
  uploadLogo,
  verifyCustomDomain,
} from "@/lib/ops-client";
import type {
  ApiErrorBody,
  BrandingSettings,
  ReportInboxSettings,
  SsoConnectionRow,
} from "@/lib/types";

const INBOX_PORTS = [993, 143, 2525];
const SSO_DEFAULT_ROLES = ["analyst", "viewer", "admin"] as const;

// ─── white label ─────────────────────────────────────────────────────────────

export function WhiteLabelForm({
  organizationId,
  branding,
  allowLogoUpload,
  allowWhiteLabel,
}: {
  organizationId: string;
  branding: BrandingSettings;
  allowLogoUpload: boolean;
  allowWhiteLabel: boolean;
}) {
  const router = useRouter();
  const [primary, setPrimary] = useState(branding.brandPrimaryColor ?? "#0a0a0a");
  const [accent, setAccent] = useState(branding.brandAccentColor ?? "#e6e4dd");
  const [customDomain, setCustomDomainText] = useState(branding.customDomain ?? "");
  /**
   * Field-level complaint, kept apart from the API error.
   *
   * An empty domain used to submit as null, which the API answers by clearing
   * the saved domain, and the form then printed "Custom domain saved. Publish the
   * record below" over a page with no domain and no record. The two are different
   * failures and need different sentences, so the empty case is caught here
   * before it reaches the API.
   */
  const [domainError, setDomainError] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<ApiErrorBody["error"] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * The TXT record to publish, held only for this session.
   *
   * `setCustomDomain` generates a fresh random token on every call and no
   * endpoint returns it again, so this leaves with the page. That is why it is
   * shown the moment it is issued and why the copy says so.
   */
  const [instructions, setInstructions] = useState<{
    host: string;
    value: string;
  } | null>(null);

  async function saveColours() {
    setBusy(true);
    setError(null);
    const res = await patchBranding(organizationId, {
      brandPrimaryColor: primary,
      brandAccentColor: accent,
    });
    setBusy(false);
    if (!res.ok) setError(res.error);
    else {
      setNote("Brand colours saved.");
      router.refresh();
    }
  }

  async function doUpload() {
    if (!file) return;
    setBusy(true);
    setError(null);
    setNote(null);
    const res = await uploadLogo(organizationId, file);
    setBusy(false);
    if (!res.ok) setError(res.error);
    else {
      setNote("Logo uploaded and confirmed.");
      setFile(null);
      router.refresh();
    }
  }

  async function saveDomain() {
    const entered = customDomain.trim();
    if (!entered) {
      setDomainError("Enter the domain you want client pages served from, for example portal.clientbrand.example.");
      setNote(null);
      setError(null);
      setInstructions(null);
      return;
    }
    setDomainError(null);
    setBusy(true);
    setError(null);
    const res = await setCustomDomain(organizationId, entered);
    setBusy(false);
    if (!res.ok) {
      setDomainError(res.error.message ?? "That domain could not be saved.");
      return;
    }

    /**
     * Keep the record the API just generated.
     *
     * `setCustomDomain` mints a new random token on every call, so this is the
     * only moment the TXT host and value exist. Letting it fall through meant
     * the operator was told to "publish the TXT record" with no record to
     * publish, and no way to reach one afterwards.
     */
    const record =
      res.data.verificationHost && res.data.verificationValue
        ? { host: res.data.verificationHost, value: res.data.verificationValue }
        : null;
    setInstructions(record);
    setNote(
      record
        ? "Custom domain saved. Publish the TXT record below at your DNS provider, then verify."
        : "The custom domain was saved but no verification record came back. Reload the page and save again to get one.",
    );
    router.refresh();
  }

  /**
   * Removing the domain is a separate action, not an empty save.
   *
   * The API accepts null to clear, which is how an empty box used to end the
   * domain without anyone meaning to. Clearing is now deliberate and says what
   * it did, so a silent removal cannot be mistaken for a failed save.
   */
  async function removeDomain() {
    setBusy(true);
    setError(null);
    setDomainError(null);
    const res = await setCustomDomain(organizationId, null);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setInstructions(null);
    setCustomDomainText("");
    setNote("Custom domain removed. Client pages are back on the default brand.");
    router.refresh();
  }

  async function doVerify() {
    setBusy(true);
    setError(null);
    const res = await verifyCustomDomain(organizationId);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }

    /**
     * The answer is in the body, not in the status code.
     *
     * A 200 here can mean the record was found, that it is missing, or that
     * the lookup timed out, and `verified` plus `lookupStatus` are what tell
     * those apart. Reading only `res.ok` printed "the custom domain is live"
     * on a hostname that resolves to nothing, which is the worst possible
     * thing to claim on a paid feature: the customer reconfigures their DNS,
     * waits for propagation, and is told it worked.
     */
    if (res.data.verified) {
      setNote("TXT record verified: the custom domain is live.");
      setInstructions(null);
    } else {
      /**
       * The record stays on screen.
       *
       * It used to be cleared here, which is the moment the operator most needs
       * it: a failed lookup usually means the record was mistyped or is still
       * propagating, and hiding what they were told to publish leaves them
       * comparing their DNS against memory.
       */
      setError({
        message:
          res.data.error ??
          "The TXT record was not found yet. Check the record above, allow it to propagate, then verify again.",
      });
    }
    router.refresh();
  }

  return (
    <section
      className="lift flex flex-col gap-4 rounded-[2px] border p-5"
      style={{ background: "var(--color-surface)", borderColor: "var(--color-line)" }}
    >
      <h2 className="text-[16.5px] font-semibold tracking-[-0.012em]">White label</h2>

      {!allowWhiteLabel ? (
        <EntitlementNotice
          error={{
            feature: "branding.whitelabel",
            message: "White-labelling is not included in this plan.",
          }}
        />
      ) : (
        <>
          {error ? (
            error.code === "FEATURE_NOT_IN_PLAN" ? (
              <EntitlementNotice error={error} />
            ) : (
              <p role="alert" className="text-[14px]" style={{ color: "var(--color-block)" }}>
                {error.message}
              </p>
            )
          ) : null}
          {note ? (
            <p role="status" className="text-[13.5px]" style={{ color: "var(--color-pass)" }}>
              {note}
            </p>
          ) : null}

          <div className="grid grid-cols-2 gap-3">
            <Field label="Primary colour">
              <input type="color" value={primary} onChange={(e) => setPrimary(e.target.value)} />
            </Field>
            <Field label="Accent colour">
              <input type="color" value={accent} onChange={(e) => setAccent(e.target.value)} />
            </Field>
          </div>
          <ActionButton
            label="Save colours"
            loadingLabel="Saving…"
            busy={busy}
            onClick={saveColours}
            variant="ghost"
            style={{ alignSelf: "flex-start" }}
          />

          <div className="border-t pt-4" style={{ borderColor: "var(--color-line)" }}>
            <Field label="Client portal logo">
              {branding.brandLogoUrl ? (
                <p className="num text-[12.5px]" style={{ color: "var(--color-ink-3)" }}>
                  a logo is set for this workspace (uploaded object, never a typed URL)
                </p>
              ) : (
                <p className="num text-[12.5px]" style={{ color: "var(--color-ink-3)" }}>
                  no logo yet
                </p>
              )}
              <input
                type="file"
                accept="image/svg+xml,image/png,image/jpeg,image/webp"
                disabled={!allowLogoUpload}
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
              {!allowLogoUpload ? (
                <span className="text-[12.5px]" style={{ color: "var(--color-ink-3)" }}>
                  not available on your current plan
                </span>
              ) : (
                <span className="text-[12.5px]" style={{ color: "var(--color-ink-3)" }}>
                  SVG, PNG, JPEG or WebP · 256KB maximum · uploaded, never linked
                </span>
              )}
            </Field>
            {allowLogoUpload && file ? (
              <ActionButton
                label="Upload logo"
                loadingLabel="Uploading…"
                busy={busy}
                onClick={doUpload}
                style={{ marginTop: 8, alignSelf: "flex-start" }}
              />
            ) : null}
          </div>

          <div className="border-t pt-4" style={{ borderColor: "var(--color-line)" }}>
            <Field label="Custom domain">
              <input
                type="text"
                value={customDomain}
                onChange={(e) => {
                  setCustomDomainText(e.target.value);
                  if (domainError) setDomainError(null);
                }}
                placeholder="portal.clientbrand.example"
                aria-describedby="custom-domain-help"
              />
            </Field>
            {domainError ? (
              <p role="alert" className="mt-2 text-[12.5px]" style={{ color: "var(--color-block)" }}>
                {domainError}
              </p>
            ) : null}
            <p id="custom-domain-help" className="mt-1.5 text-[12.5px]" style={{ color: "var(--color-ink-3)" }}>
              The host name you want client pages served from, for example{" "}
              <span className="num">portal.clientbrand.example</span>. Write it as a
              bare domain: <span className="num">https://</span> in front is not
              needed and is stripped if you include it.
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <ActionButton
                label="Save domain"
                loadingLabel="Saving…"
                busy={busy}
                onClick={saveDomain}
                variant="ghost"
                disabled={!customDomain.trim()}
              />
              {branding.customDomain ? (
                <ActionButton
                  label="Remove domain"
                  loadingLabel="Removing…"
                  busy={busy}
                  onClick={removeDomain}
                  variant="ghost"
                />
              ) : null}
              {branding.customDomain && !branding.customDomainVerifiedAt ? (
                <ActionButton
                  label="verify TXT record"
                  loadingLabel="Verifying…"
                  busy={busy}
                  onClick={doVerify}
                  variant="ghost"
                  style={{ border: "none", color: "var(--color-unverified)", padding: 0 }}
                />
              ) : null}
              {branding.customDomainVerifiedAt ? (
                <span className="num text-[11.5px] tracking-[0.12em] uppercase" style={{ color: "var(--color-pass)" }}>
                  verified
                </span>
              ) : null}
            </div>

            {/*
              The record, written out as a DNS provider asks for it.

              "Publish the TXT record below" is unusable on its own: a DNS form
              asks for a type, a host or name, and a value, and the previous
              block answered only two of the three. Everything here is filled in
              with the real values for this domain, and the example underneath
              shows the same record the way it would look in a provider form, so
              there is nothing left to infer.
            */}
            {instructions ? (
              <div
                className="lift mt-3 rounded-[2px] border p-4"
                style={{ borderColor: "var(--color-unverified)", background: "var(--color-unverified-soft)" }}
                data-testid="custom-domain-record"
              >
                <p className="num text-[11px] font-semibold tracking-[0.12em] uppercase" style={{ color: "var(--color-unverified)" }}>
                  Publish this TXT record at your DNS provider
                </p>
                <dl className="mt-3 flex flex-col gap-2 text-[12.5px]">
                  <div className="flex flex-wrap items-baseline gap-x-3">
                    <dt className="num w-20 shrink-0 tracking-[0.1em] uppercase" style={{ color: "var(--color-ink-3)" }}>Type</dt>
                    <dd className="num" style={{ color: "var(--color-ink)" }}>TXT</dd>
                  </div>
                  <div className="flex flex-wrap items-baseline gap-x-3">
                    <dt className="num w-20 shrink-0 tracking-[0.1em] uppercase" style={{ color: "var(--color-ink-3)" }}>Host / name</dt>
                    <dd className="num break-all" style={{ color: "var(--color-ink)" }} data-testid="record-host">{instructions.host}</dd>
                  </div>
                  <div className="flex flex-wrap items-baseline gap-x-3">
                    <dt className="num w-20 shrink-0 tracking-[0.1em] uppercase" style={{ color: "var(--color-ink-3)" }}>Value</dt>
                    <dd className="num break-all" style={{ color: "var(--color-ink)" }} data-testid="record-value">{instructions.value}</dd>
                  </div>
                </dl>
                <p className="mt-3 border-t pt-3 text-[11.5px]" style={{ borderColor: "var(--color-line)", color: "var(--color-ink-3)" }}>
                  In a provider that asks for one field per part, that is type{" "}
                  <span className="num">TXT</span>, host{" "}
                  <span className="num">{instructions.host}</span>, value{" "}
                  <span className="num">{instructions.value}</span>. Leave the
                  host exactly as written: it is the whole name including the
                  leading underscore, not a name to be appended to your domain.
                </p>
                <p className="mt-2 text-[11.5px]" style={{ color: "var(--color-ink-3)" }}>
                  Shown once, when the domain is saved. Copy it before leaving
                  this page: the token is not recoverable, and saving again
                  issues a different one.
                </p>
              </div>
            ) : null}

            <p className="mt-1.5 text-[12.5px]" style={{ color: "var(--color-ink-3)" }}>
              A custom domain serves only after its TXT record is verified.
            </p>
          </div>
        </>
      )}
    </section>
  );
}

// ─── report mailbox ──────────────────────────────────────────────────────────

export function ReportInboxForm({
  organizationId,
  inbox,
}: {
  organizationId: string;
  inbox: ReportInboxSettings;
}) {
  const router = useRouter();
  const [host, setHost] = useState(inbox.host ?? "");
  const [port, setPort] = useState(993);
  const [secure, setSecure] = useState(true);
  const [username, setUsername] = useState(inbox.username ?? "");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<ApiErrorBody["error"] | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await setReportInbox(organizationId, {
      host,
      port,
      secure,
      username,
      password,
    });
    setBusy(false);
    setPassword(""); // write-only: never kept after the round trip
    if (!res.ok) setError(res.error);
    else router.refresh();
  }

  return (
    <section
      className="lift flex flex-col gap-4 rounded-[2px] border p-5"
      style={{ background: "var(--color-surface)", borderColor: "var(--color-line)" }}
    >
      <h2 className="text-[16.5px] font-semibold tracking-[-0.012em]">Report mailbox</h2>
      <p className="text-[13.5px]" style={{ color: "var(--color-ink-2)" }}>
        One shared mailbox per workspace. Every domain points its rua tag at our
        reporting address, so no customer ever hands over IMAP credentials.
      </p>

      {error ? (
        error.code === "FEATURE_NOT_IN_PLAN" ? (
          <EntitlementNotice error={error} />
        ) : (
          <p role="alert" className="text-[14px]" style={{ color: "var(--color-block)" }}>
            {error.message}
          </p>
        )
      ) : null}

      {inbox.configured ? (
        <div
          className="num flex items-center gap-4 text-[12.5px]"
          style={{ color: "var(--color-ink-3)" }}
        >
          <span>{inbox.username}@{inbox.host}</span>
          <span>last polled {inbox.lastPolledAt ? new Date(inbox.lastPolledAt).toLocaleDateString("en-GB") : "never"}</span>
          {inbox.lastError ? (
            <span style={{ color: "var(--color-fail, var(--color-block))" }}>
              {inbox.consecutiveFailures} consecutive failures
            </span>
          ) : null}
        </div>
      ) : null}

      <form onSubmit={save} className="grid grid-cols-2 gap-3">
        <Field label="Host">
          <input value={host} onChange={(e) => setHost(e.target.value)} required minLength={3} />
        </Field>
        <Field label="Port">
          <select value={port} onChange={(e) => setPort(Number(e.target.value))}>
            {INBOX_PORTS.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </Field>
        <Field label="Username">
          <input value={username} onChange={(e) => setUsername(e.target.value)} required minLength={3} />
        </Field>
        <Field label="Password">
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required={!inbox.configured}
            autoComplete="new-password"
          />
        </Field>
        <div className="col-span-2 flex items-center gap-3">
          <label className="flex items-center gap-2 text-[13.5px]" style={{ color: "var(--color-ink-2)" }}>
            <input type="checkbox" checked={secure} onChange={(e) => setSecure(e.target.checked)} />
            TLS
          </label>
          <ActionButton
            label={inbox.configured ? "Update mailbox" : "Connect mailbox"}
            loadingLabel="Saving…"
            busy={busy}
            type="submit"
          />
          {inbox.configured ? (
            <button
              type="button"
              onClick={async () => {
                const res = await removeReportInbox(organizationId);
            if (!res.ok) setError(res.error);
            else router.refresh();
              }}
              className="text-[12.5px] underline"
              style={{ color: "var(--color-block)" }}
            >
              disconnect
            </button>
          ) : null}
        </div>
      </form>
      {inbox.configured ? <PollInboxNow organizationId={organizationId} /> : null}
      <p className="text-[12.5px]" style={{ color: "var(--color-ink-3)" }}>
        Ports 993, 143 and 2525 only: the API refuses others. The password is
        write-only: it is never returned and never stored in this browser.
      </p>
    </section>
  );
}

/**
 * Polls the mailbox immediately.
 *
 * The endpoint has existed with no control for it anywhere, which made the only
 * way to check a mailbox was to point a rua tag at it and wait for the next
 * automatic run. That is the wrong order: a wrong host, port or password is
 * discovered by a customer whose reports quietly never arrive.
 *
 * A failure is not silent here. The API records it against the mailbox so the
 * status above shows it, and this reports it as well, because "read 0 messages"
 * and "the mailbox is broken" are otherwise indistinguishable.
 */
function PollInboxNow({ organizationId }: { organizationId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  async function poll() {
    setBusy(true);
    const result = await pollReportInboxNow(organizationId);
    setBusy(false);

    if (!result.ok) {
      setFailed(result.error.message ?? "The mailbox could not be read.");
      return;
    }
    setFailed(null);

    const { messages, accepted, duplicates, unmatched } = result.data;
    const parts = [`Read ${messages} message${messages === 1 ? "" : "s"}`, `${accepted} new report${accepted === 1 ? "" : "s"}`];
    if (duplicates > 0) parts.push(`${duplicates} already seen`);
    if (unmatched > 0) parts.push(`${unmatched} not for a monitored domain`);
    setOutcome(`${parts.join(", ")}.`);
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-1">
      <ActionButton
        label="Poll the mailbox now"
        loadingLabel="Polling"
        busy={busy}
        variant="ghost"
        onClick={poll}
      />
      {outcome ? (
        <p className="text-[12.5px]" style={{ color: "var(--color-ink-2)" }}>
          {outcome}
        </p>
      ) : null}
      {failed ? (
        <p className="text-[12.5px]" style={{ color: "var(--color-danger, #b4232a)" }}>
          {failed}
        </p>
      ) : null}
    </div>
  );
}

// ─── SSO ─────────────────────────────────────────────────────────────────────

export function SsoSection({
  organizationId,
  connections,
}: {
  organizationId: string;
  connections: SsoConnectionRow[];
}) {
  const router = useRouter();
  const [label, setLabel] = useState("");
  const [protocol, setProtocol] = useState<"SAML" | "OIDC">("SAML");
  const [issuer, setIssuer] = useState("");
  const [entryPoint, setEntryPoint] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [provisioning, setProvisioning] = useState<"JIT" | "DISABLED">("JIT");
  const [domainsText, setDomainsText] = useState("");
  const [defaultRole, setDefaultRole] = useState<"analyst" | "viewer" | "admin">("analyst");
  const [error, setError] = useState<ApiErrorBody["error"] | null>(null);
  const [busy, setBusy] = useState(false);

  const allowedEmailDomains = domainsText
    .split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const jitNeedsDomains = provisioning === "JIT" && allowedEmailDomains.length === 0;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (jitNeedsDomains) return; // the constraint is shown before save, not after
    setBusy(true);
    setError(null);
    const res = await createSsoConnection(organizationId, {
      label,
      protocol,
      issuer,
      entryPoint,
      clientId,
      clientSecret,
      provisioning,
      allowedEmailDomains,
      defaultRole,
    });
    setBusy(false);
    setClientSecret(""); // write-only: never kept after the round trip
    if (!res.ok) setError(res.error);
    else {
      setLabel("");
      router.refresh();
    }
  }

  return (
    <section
      className="lift flex flex-col gap-4 rounded-[2px] border p-5"
      style={{ background: "var(--color-surface)", borderColor: "var(--color-line)" }}
    >
      <h2 className="text-[16.5px] font-semibold tracking-[-0.012em]">Single sign-on</h2>

      {connections.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {connections.map((c) => (
            <li
              key={c.id}
              className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b pb-2"
              style={{ borderColor: "rgba(255,255,255,0.055)" }}
            >
              <span className="text-[14px]" style={{ color: "var(--color-ink)" }}>{c.label}</span>
              <span className="num text-[12px]" style={{ color: "var(--color-ink-3)" }}>
                {c.protocol} · {c.provisioning.toLowerCase()} · default role {c.defaultRole}
              </span>
              {c.allowedEmailDomains.length > 0 ? (
                <span
                  data-testid="sso-allowlist"
                  className="num text-[11.5px]"
                  style={{ color: "var(--color-ink-3)" }}
                >
                  allowlist: {c.allowedEmailDomains.join(", ")}
                </span>
              ) : null}
              <button
                type="button"
                onClick={async () => {
                  const res = await removeSsoConnection(organizationId, c.id);
            if (!res.ok) setError(res.error);
            else router.refresh();
                }}
                className="ml-auto text-[12.5px] underline"
                style={{ color: "var(--color-block)" }}
              >
                delete
              </button>
              {/*
                The values an IdP console asks the administrator for. The API has
                always computed these, and the copy below promised the callback
                URL would be "shown on the connection after it is created" while
                nothing rendered it - so a connection existed that could not
                actually be configured. None of these is a secret and none is
                derivable from the others, which is why all four are shown.
              */}
              <dl
                data-testid="sso-connection-config"
                className="basis-full pt-1 text-[11.5px]"
              >
                <SsoConfigRow label={c.protocol === "SAML" ? "ACS URL (SAML)" : "Redirect URL (OIDC)"} value={c.callbackUrls[c.protocol.toLowerCase() as "saml" | "oidc"]} />
                <SsoConfigRow label="Entity ID" value={c.entityId} />
                <SsoConfigRow label="IdP entity ID" value={c.idpEntityId} />
                <SsoConfigRow label="IdP sign-in URL" value={c.loginUrl} />
              </dl>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[13.5px]" style={{ color: "var(--color-ink-3)" }}>
          No identity provider connected.
        </p>
      )}

      <form onSubmit={save} className="flex flex-col gap-3 border-t pt-4" style={{ borderColor: "var(--color-line)" }}>
        {error ? (
          error.code === "FEATURE_NOT_IN_PLAN" ? (
            <EntitlementNotice error={error} />
          ) : (
            <p role="alert" className="text-[14px]" style={{ color: "var(--color-block)" }}>
              {error.message}
            </p>
          )
        ) : null}

        <div className="grid grid-cols-2 gap-3">
          <Field label="Label">
            <input value={label} onChange={(e) => setLabel(e.target.value)} required />
          </Field>
          <Field label="Protocol">
            <select value={protocol} onChange={(e) => setProtocol(e.target.value as "SAML" | "OIDC")}>
              <option value="SAML">SAML</option>
              <option value="OIDC">OIDC</option>
            </select>
          </Field>
          <Field label="Issuer">
            <input value={issuer} onChange={(e) => setIssuer(e.target.value)} required />
          </Field>
          <Field label="Entry point (URL)">
            <input
              type="text"
              value={entryPoint}
              onChange={(e) => setEntryPoint(e.target.value)}
              required
              inputMode="url"
            />
          </Field>
          <Field label="Client ID">
            <input value={clientId} onChange={(e) => setClientId(e.target.value)} required />
          </Field>
          <Field label="Client secret">
            <input
              type="password"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              required
              autoComplete="new-password"
            />
          </Field>
          <Field label="Provisioning">
            <select
              value={provisioning}
              onChange={(e) => setProvisioning(e.target.value as "JIT" | "DISABLED")}
            >
              <option value="JIT">JIT</option>
              <option value="DISABLED">Disabled</option>
            </select>
          </Field>
          <Field label="Default role">
            <select
              value={defaultRole}
              onChange={(e) => setDefaultRole(e.target.value as "analyst" | "viewer" | "admin")}
            >
              {SSO_DEFAULT_ROLES.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
          </Field>
        </div>

        <Field label="Allowed email domains (comma separated)">
          <input
            value={domainsText}
            onChange={(e) => setDomainsText(e.target.value)}
            placeholder="clientcorp.example, group.clientcorp.example"
          />
        </Field>

        {jitNeedsDomains ? (
          <p role="status" className="text-[13px]" style={{ color: "var(--color-unverified)" }}>
            JIT provisioning requires at least one allowed email domain: the API
            refuses the connection without one. Add the domains your identity
            provider will assert before saving.
          </p>
        ) : null}

        <p className="text-[12.5px]" style={{ color: "var(--color-ink-3)" }}>
          The provider secret is write-only: it is stored server-side and never
          returned. The callback URL and the rest of the values your identity
          provider asks for are shown on each connection below, and come from the
          connection itself rather than being constructed here. Owner is never a
          default role; the API does not accept it.
        </p>

        <ActionButton
          label="Add SSO connection"
          loadingLabel="Saving…"
          busy={busy}
          disabled={jitNeedsDomains}
          type="submit"
          style={{ alignSelf: "flex-start" }}
        />
      </form>
    </section>
  );
}

/**
 * One value an administrator has to copy into their identity provider.
 *
 * Selectable rather than plain text because these get pasted into a form in
 * another tab, and re-typing a URL by hand is how a connection ends up pointing
 * at a mistyped host.
 */
function SsoConfigRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2">
      <dt className="num text-[10.5px] tracking-[0.12em] uppercase" style={{ color: "var(--color-ink-3)" }}>
        {label}
      </dt>
      <dd className="num select-all break-all" style={{ color: "var(--color-ink-2)" }}>
        {value}
      </dd>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {  return (
    <label className="flex flex-col gap-1.5">
      <span className="label">{label}</span>
      {children}
      <style>{`
        label select, label input:not([type="checkbox"]) {
          background: var(--color-elevate);
          border: 1px solid var(--color-line-strong);
          border-radius: 2px;
          color: var(--color-ink);
          padding: 7px 10px;
          font-size: 14px;
          outline: revert;
        }
      `}</style>
    </label>
  );
}
