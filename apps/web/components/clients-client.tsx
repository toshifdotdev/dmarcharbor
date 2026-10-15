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

import { ActionButton } from "@/components/action-button";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { EntitlementNotice } from "@/components/entitlement-gate";
import { createClient, createDomain } from "@/lib/ops-client";
import { onboardingHref } from "@/lib/route-hrefs";
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
            placeholder="Example Freight"
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
            placeholder="example-freight"
            data-testid="client-slug"
          />
        </Field>
      </div>

      <ActionButton
        type="submit"
        label={"Create client"}
        loadingLabel={"Creating…"}
        busy={busy}
        disabled={!name.trim()}
        testId="create-client"
        style={{ marginTop: 16 }}
      />
    </form>
  );
}

/**
 * `clients` is optional so existing single-client call sites keep working, but
 * the /clients page passes it. Without it the form was pointed at the last row
 * of the list, so in a workspace with more than one client every domain was
 * silently added to whichever client happened to sort last.
 */
export function AddDomainForm({
  organizationId,
  clients,
  clientId,
  clientName,
}: {
  organizationId: string;
  clients?: Array<{ id: string; name: string }>;
  clientId?: string;
  clientName?: string;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [error, setError] = useState<ApiErrorBody["error"] | null>(null);
  const [busy, setBusy] = useState(false);
  const [createdSlug, setCreatedSlug] = useState<string | null>(null);
  const [target, setTarget] = useState(
    clients && clients.length > 0 ? clients[0] : clientId ? { id: clientId, name: clientName ?? "" } : null,
  );

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!target) {
      setError({ code: "INVALID_REQUEST", message: "Choose which client this domain belongs to." });
      return;
    }
    setBusy(true);
    setError(null);
    const res = await createDomain(organizationId, target.id, {
      name: name.trim().toLowerCase(),
    });
    setBusy(false);
    if (!res.ok) setError(res.error);
    else {
      setCreatedSlug(res.data.slug);
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
      {clients && clients.length > 0 ? (
        <>
          <h2 className="text-[16.5px] font-semibold tracking-[-0.012em]">Add a domain</h2>
          <label className="mt-3 block">
            <span className="label">Client</span>
            <select
              className="mt-1 w-full rounded-[2px] border bg-transparent px-3 py-2 text-[14px]"
              style={{ borderColor: "var(--color-line-strong)", color: "var(--color-ink)" }}
              value={target?.id ?? ""}
              onChange={(e) => {
                const picked = clients.find((c) => c.id === e.target.value) ?? null;
                setTarget(picked);
              }}
            >
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        </>
      ) : (

        <h2 className="text-[16px] font-semibold tracking-[-0.012em]">
          Add a domain to {target?.name ?? clientName ?? ""}
        </h2>
      )}
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

      {createdSlug ? (
        <p role="status" className="mt-3 text-[13px]" style={{ color: "var(--color-pass)" }}>
          Domain added.{" "}
          <a
            href={onboardingHref(createdSlug)}
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
              placeholder="example.com"
              data-testid="domain-name"
            />
          </Field>
        </div>
        <ActionButton
          type="submit"
          label={"Add domain"}
          loadingLabel={"Adding…"}
          busy={busy}
          disabled={!name.trim()}
          testId="add-domain"
        />
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
          outline: revert;
          width: 100%;
        }
      `}</style>
    </label>
  );
}
