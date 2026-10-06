"use client";

/**
 * trust-center-client.tsx — publish and withdraw the client Trust Center.
 *
 * The public page and the verifier already exist; this is the only place a
 * link is minted or taken down. Publishing a link publishes a claim about a
 * client's data, so it is a paid capability (the API gates it on trust.center)
 * and withdrawal is confirm-gated: it takes a page an auditor may be reading.
 *
 * Slug rotation is the answer to "what if this link leaks": revoking and
 * publishing again mints a NEW unguessable slug, so the leaked address dies
 * with the old one. That is said where the revoke button is, because that is
 * where the question arrives.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ActionButton } from "@/components/action-button";
import { ConfirmAction } from "@/components/confirm-action";
import { createTrustCenter, revokeTrustCenter } from "@/lib/ops-client";
import type { ApiErrorBody, TrustSlugStatus } from "@/lib/types";

export function TrustCenterPanel({
  organizationId,
  clientId,
  clientName,
  initial,
  origin,
}: {
  organizationId: string;
  clientId: string;
  clientName: string;
  initial: TrustSlugStatus;
  /** The public origin this request was served on: a branded custom domain's
   *  trust page lives on the agency's host, not ours. */
  origin: string;
}) {
  const router = useRouter();
  const [status, setStatus] = useState<TrustSlugStatus>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiErrorBody["error"] | string | null>(null);
  const [copied, setCopied] = useState(false);

  const publicUrl = status.url
    ? status.url.startsWith("http")
      ? status.url
      : `${origin}${status.url}`
    : null;

  async function publish() {
    setBusy(true);
    setError(null);
    const res = await createTrustCenter(organizationId, clientId);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setStatus({ slug: res.data.slug, url: res.data.url });
    router.refresh();
  }

  async function withdraw() {
    setBusy(true);
    setError(null);
    const res = await revokeTrustCenter(organizationId, clientId);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setStatus({ slug: null, url: null });
    router.refresh();
  }

  return (
    <section
      className="lift rounded-[2px] border p-5"
      style={{ background: "var(--color-surface)", borderColor: "var(--color-line)" }}
      data-feature="trust.center"
    >
      <h2 className="text-[16px] font-semibold tracking-[-0.012em]">
        Trust Center: {clientName}
      </h2>
      <p className="mt-2 text-[13px]" style={{ color: "var(--color-ink-2)" }}>
        An unguessable public address an auditor opens with no account. It
        publishes what was measured about this client and never names another
        one.
      </p>

      {status.url ? (
        <div className="mt-3" data-testid="trust-published">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className="num rounded-[2px] border px-3 py-2 text-[12px] break-all"
              style={{
                background: "var(--color-elevate)",
                borderColor: "var(--color-line-strong)",
                color: "var(--color-ink)",
              }}
            >
              {publicUrl}
            </span>
            <ActionButton
              label={copied ? "copied" : "copy"}
              loadingLabel="Copying…"
              busy={false}
              variant="ghost"
              testId="trust-copy"
              onClick={async () => {
                if (!publicUrl) return;
                try {
                  await navigator.clipboard.writeText(publicUrl);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                } catch {
                  setCopied(false);
                }
              }}
              style={{ padding: "6px 12px", fontSize: "12px" }}
            />
          </div>
          <p className="mt-2 text-[12px]" style={{ color: "var(--color-ink-3)" }}>
            Published. Anyone holding this address can read this client's
            measurements until it is withdrawn.
          </p>
          <ConfirmAction
            label="Withdraw the link"
            confirmLabel="Withdraw it now"
            consequence={`Take ${clientName}'s Trust Center down? Anyone holding the address stops being able to open it immediately.`}
            onConfirm={withdraw}
            busy={busy}
            testId="trust-revoke"
          />
          <p className="mt-2.5 text-[12px]" style={{ color: "var(--color-ink-3)" }}>
            If the link ever leaks, withdraw it and publish again: the new link
            is a different address, so the old one stays dead.
          </p>
        </div>
      ) : (
        <div className="mt-3">
          <ActionButton
            label="Publish the Trust Center"
            loadingLabel="Publishing…"
            busy={busy}
            testId="trust-publish"
            onClick={publish}
            style={{ padding: "8px 16px", fontSize: "13px" }}
          />
          <p className="mt-2 text-[12px]" style={{ color: "var(--color-ink-3)" }}>
            Not published. There is no public address for this client until one
            is issued here.
          </p>
        </div>
      )}

      {error ? (
        <p role="alert" className="mt-3 text-[13px]" style={{ color: "var(--color-block)" }}>
          {typeof error === "string" ? error : error.message}
        </p>
      ) : null}
    </section>
  );
}
