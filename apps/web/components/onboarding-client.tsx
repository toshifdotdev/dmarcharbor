"use client";

/**
 * onboarding-client.tsx — the DNS verification controls.
 *
 * The ownership TXT record and the live lookup status both come from the
 * verify response (the API's own strings — never assembled here, so the host
 * pattern and value stay consistent with what the backend actually checks).
 *
 * "Not found yet" is a NORMAL state: DNS propagation takes minutes to hours,
 * so PENDING renders as waiting, never as failure. Only a proof that used to
 * exist and lapsed is FAILED.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { verifyDomain } from "@/lib/ops-client";
import type { VerifyDomainResult } from "@/lib/types";

export function VerifyControls({
  organizationId,
  domainId,
  initial,
  published,
}: {
  organizationId: string;
  domainId: string;
  initial: VerifyDomainResult["verification"] | null;
  published: boolean;
}) {
  const router = useRouter();
  const [result, setResult] = useState<VerifyDomainResult["verification"] | null>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function check() {
    setBusy(true);
    setError(null);
    const res = await verifyDomain(organizationId, domainId);
    setBusy(false);
    if (!res.ok) setError(res.error.message ?? "The lookup could not run.");
    else {
      setResult(res.data.verification);
      router.refresh();
    }
  }

  const record = result;

  return (
    <div className="flex flex-col gap-4">
      {record ? (
        <>
          <div>
            <div className="label">Publish this TXT record</div>
            <div
              className="lift mt-2 rounded-[2px] border"
              style={{ background: "var(--color-elevate)", borderColor: "var(--color-line-strong)" }}
            >
              <dl className="grid grid-cols-1 gap-y-2 p-4 sm:grid-cols-[7rem_minmax(0,1fr)] gap-x-6">
                <dt className="num text-[10.5px] tracking-[0.14em] uppercase" style={{ color: "var(--color-ink-3)" }}>
                  host
                </dt>
                <dd className="num text-[13px] break-all" style={{ color: "var(--color-ink)" }}>
                  {record.host}
                </dd>
                <dt className="num text-[10.5px] tracking-[0.14em] uppercase" style={{ color: "var(--color-ink-3)" }}>
                  type
                </dt>
                <dd className="num text-[13px]" style={{ color: "var(--color-ink)" }}>
                  {record.type}
                </dd>
                <dt className="num text-[10.5px] tracking-[0.14em] uppercase" style={{ color: "var(--color-ink-3)" }}>
                  value
                </dt>
                <dd className="num text-[13px] break-all" style={{ color: "var(--color-ink)" }}>
                  {record.value}
                </dd>
              </dl>
            </div>
            <button
              type="button"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(record.value);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                } catch {
                  setCopied(false);
                }
              }}
              className="mt-2 rounded-[2px] border px-3 py-1.5 text-[12px]"
              style={{ borderColor: "var(--color-line-strong)", color: "var(--color-ink-2)" }}
              data-testid="copy-ownership"
            >
              {copied ? "copied" : "copy value"}
            </button>
          </div>

          <LookupStatus verification={record} published={published} />

          <button
            type="button"
            onClick={check}
            disabled={busy}
            className="self-start rounded-[2px] px-5 py-2.5 text-[13.5px] font-semibold"
            style={{ background: "var(--color-accent)", color: "var(--color-accent-ink)" }}
            data-testid="verify-domain"
          >
            {busy ? "Checking DNS…" : result ? "Re-check DNS" : "Check DNS"}
          </button>
        </>
      ) : (
        <button
          type="button"
          onClick={check}
          disabled={busy}
          className="self-start rounded-[2px] px-5 py-2.5 text-[13.5px] font-semibold"
          style={{ background: "var(--color-accent)", color: "var(--color-accent-ink)" }}
          data-testid="verify-domain"
        >
          {busy ? "Checking DNS…" : "Show record & check DNS"}
        </button>
      )}

      {error ? (
        <p role="alert" className="text-[13px]" style={{ color: "var(--color-block)" }}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

function LookupStatus({
  verification,
  published,
}: {
  verification: VerifyDomainResult["verification"];
  published: boolean;
}) {
  if (verification.status === "VERIFIED") {
    return (
      <p
        role="status"
        data-verify-status="verified"
        className="rounded-[2px] border px-4 py-3 text-[13px]"
        style={{
          borderColor: "var(--color-pass)",
          background: "var(--color-pass-soft)",
          color: "var(--color-ink-2)",
        }}
      >
        <strong style={{ color: "var(--color-pass)" }}>Ownership verified.</strong>{" "}
        The record is live in DNS and this domain is yours to monitor.
      </p>
    );
  }

  if (verification.status === "FAILED") {
    return (
      <p
        role="status"
        data-verify-status="failed"
        className="rounded-[2px] border px-4 py-3 text-[13px]"
        style={{
          borderColor: "var(--color-block)",
          background: "var(--color-block-soft)",
          color: "var(--color-ink-2)",
        }}
      >
        <strong style={{ color: "var(--color-block)" }}>The record is no longer published.</strong>{" "}
        This domain was verified before, but the TXT record has disappeared from
        DNS. Re-publish it above to restore verification.
      </p>
    );
  }

  // PENDING — the normal propagation state. Not an error, never styled as one.
  return (
    <div
      role="status"
      data-verify-status="pending"
      className="rounded-[2px] border px-4 py-3"
      style={{
        borderColor: "var(--color-unverified)",
        background: "var(--color-unverified-soft)",
      }}
    >
      <p className="text-[13px]" style={{ color: "var(--color-ink-2)" }}>
        <strong style={{ color: "var(--color-unverified)" }}>Waiting for DNS.</strong>{" "}
        The record is not visible yet
        {published ? " — even though you have published it" : ""}. That is
        normal: DNS changes take minutes to a few hours to propagate. Re-check
        as often as you like — nothing here is an error.
      </p>
    </div>
  );
}
