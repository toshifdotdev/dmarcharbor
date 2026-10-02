"use client";

/**
 * clients-client.tsx — the funnel's first two screens.
 *
 * Workspace → client → domain is the whole data model, and these are the two
 * forms that build it. Field names follow the API contract exactly:
 * createClient({ name, slug }) with slug ^[a-z0-9]+(-[a-z0-9]+)*$, and
 * createDomain({ name }) on the client's domain collection.
 *
 * A 402 renders the upgrade prompt routed by the body's `feature` key — never
 * by matching the message.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { EntitlementNotice } from "@/components/entitlement-gate";
import { createClient, createDomain } from "@/lib/ops-client";
import type { ApiErrorBody } from "@/lib/types";

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export function CreateClientForm({ organizationId }: { organizationId: string }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [error, setError] = useState<ApiErrorBody["error"] | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await createClient(organizationId, {
      name: name.trim(),
      slug: (slugTouched ? slug : slugify(name)).trim(),
    });
    setBusy(false);
    if (!res.ok) setError(res.error);
    else {
      setName("");
      setSlug("");
      setSlugTouched(false);
      router.refresh();
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      className="lift rounded-[2px] border p-5"
      style={{ background: "var(--color-surface)", borderColor: "var(--color-line)" }}
    >
      <h2 className="text-[16px] font-semibold tracking-[-0.012em]">New client</h2>
      <p className="mt-1.5 text-[13px]" style={{ color: "var(--color-ink-2)" }}>
        A client is the company whose domains you monitor. You can add domains
        the moment it exists.
      </p>

      {error ? (
        error.code === "FEATURE_NOT_IN_PLAN" ? (
          <div className="mt-3">
            <EntitlementNotice error={error} />
          </div>
        ) : (
          <p role="alert" className="mt-3 text-[13px]" style={{ color: "var(--color-block)" }}>
            {error.message}
          </p>
        )
      ) : null}

      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Client name">
          <input
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (!slugTouched) setSlug(slugify(e.target.value));
            }}
            required
            minLength={2}
            maxLength={100}
            placeholder="Acme Freight"
            data-testid="client-name"
          />
        </Field>
        <Field label="Slug">
          <input
            value={slugTouched ? slug : slugify(name)}
            onChange={(e) => {
              setSlugTouched(true);
              setSlug(slugify(e.target.value));
            }}
            required
            minLength={2}
            pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
            title="lowercase letters, numbers and hyphens"
            placeholder="acme-freight"
            data-testid="client-slug"
          />
        </Field>
      </div>

      <button
        type="submit"
        disabled={busy || !name.trim()}
        className="mt-4 rounded-[2px] px-5 py-2.5 text-[13.5px] font-semibold"
        style={{ background: "var(--color-accent)", color: "var(--color-accent-ink)" }}
        data-testid="create-client"
      >
        {busy ? "Creating…" : "Create client"}
      </button>
    </form>
  );
}

export function AddDomainForm({
  organizationId,
  clientId,
  clientName,
}: {
  organizationId: string;
  clientId: string;
  clientName: string;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [error, setError] = useState<ApiErrorBody["error"] | null>(null);
  const [busy, setBusy] = useState(false);
  const [createdId, setCreatedId] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await createDomain(organizationId, clientId, {
      name: name.trim().toLowerCase(),
    });
    setBusy(false);
    if (!res.ok) setError(res.error);
    else {
      setCreatedId(res.data.id);
      setName("");
      router.refresh();
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      className="lift rounded-[2px] border p-5"
      style={{ background: "var(--color-surface)", borderColor: "var(--color-line)" }}
    >
      <h2 className="text-[16px] font-semibold tracking-[-0.012em]">
        Add a domain to {clientName}
      </h2>
      <p className="mt-1.5 text-[13px]" style={{ color: "var(--color-ink-2)" }}>
        Paste the domain exactly as it sends mail. Verification comes next.
      </p>

      {error ? (
        error.code === "FEATURE_NOT_IN_PLAN" ? (
          <div className="mt-3">
            <EntitlementNotice error={error} />
          </div>
        ) : (
          <p role="alert" className="mt-3 text-[13px]" style={{ color: "var(--color-block)" }}>
            {error.message}
          </p>
        )
      ) : null}

      {createdId ? (
        <p role="status" className="mt-3 text-[13px]" style={{ color: "var(--color-pass)" }}>
          Domain added.{" "}
          <a
            href={`/onboarding/${createdId}`}
            className="underline"
            style={{ color: "var(--color-ink)" }}
            data-testid="continue-setup"
          >
            Continue setup →
          </a>
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap items-end gap-3">
        <div className="min-w-[260px] flex-1">
          <Field label="Domain">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              minLength={3}
              placeholder="acmefreight.com"
              data-testid="domain-name"
            />
          </Field>
        </div>
        <button
          type="submit"
          disabled={busy || !name.trim()}
          className="rounded-[2px] px-5 py-2.5 text-[13.5px] font-semibold"
          style={{ background: "var(--color-accent)", color: "var(--color-accent-ink)" }}
          data-testid="add-domain"
        >
          {busy ? "Adding…" : "Add domain"}
        </button>
      </div>
    </form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="label">{label}</span>
      {children}
      <style>{`
        label input:not([type="checkbox"]) {
          background: var(--color-elevate);
          border: 1px solid var(--color-line-strong);
          border-radius: 2px;
          color: var(--color-ink);
          padding: 8px 11px;
          font-size: 14px;
          outline: none;
          width: 100%;
        }
      `}</style>
    </label>
  );
}
