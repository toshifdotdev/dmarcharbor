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
import { bulkCreateDomains, createClient, createDomain, type BulkDomainResult } from "@/lib/ops-client";
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

  /**
   * One domain or many.
   *
   * A toggle rather than two forms, because the client picker and the wording
   * are identical either way and two near-identical forms drift apart the moment
   * either changes.
   */
  const [many, setMany] = useState(false);
  const [pasted, setPasted] = useState("");
  const [result, setResult] = useState<BulkDomainResult | null>(null);

  /**
   * Split here rather than server-side, so the count in the button is the count
   * that will be sent. Silent trimming on the server would make the button say
   * "Add 5" and the request carry 3, which is the sort of mismatch that makes an
   * operator distrust the summary underneath it.
   *
   * Lowercased because a DNS name is case-insensitive and the uniqueness
   * constraint is plain; one canonical stored form is what makes the constraint
   * mean what routing assumed.
   */
  const lines = pasted
    .split(/[\r\n,;]+/)
    .map((line) => line.trim().toLowerCase())
    .filter(Boolean);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!target) {
      setError({ code: "INVALID_REQUEST", message: "Choose which client this domain belongs to." });
      return;
    }

    setBusy(true);
    setError(null);
    setResult(null);

    if (many) {
      const res = await bulkCreateDomains(organizationId, target.id, lines);
      setBusy(false);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setResult(res.data);
      // The pasted list is cleared, not the textarea, because the failures below
      // it are the reason somebody comes back to fix a typo and re-paste.
      setPasted("");
      router.refresh();
      return;
    }

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
        {many
          ? "An agency's domain list arrives as a list. Paste the lot and see which rows went in."
          : "Paste the domain exactly as it sends mail. Verification comes next."}
      </p>

      {/* The switch lives here rather than on the form's edge because it changes
          what the form IS, not which client it targets. */}
      <div className="mt-3 inline-flex gap-1" role="tablist" aria-label="How many domains">
        {([
          { key: false, label: "One domain" },
          { key: true, label: "Many domains" },
        ] as const).map((option) => (
          <button
            key={String(option.key)}
            type="button"
            role="tab"
            aria-selected={many === option.key}
            onClick={() => {
              setMany(option.key);
              setError(null);
              setResult(null);
            }}
            data-testid={option.key ? "bulk-mode" : "single-mode"}
            className="cursor-pointer rounded-[2px] border px-3 py-1 text-[12px] font-medium transition-colors disabled:cursor-not-allowed"
            style={{
              borderColor: many === option.key ? "var(--color-accent)" : "var(--color-line-strong)",
              background: many === option.key ? "var(--color-accent-soft)" : "transparent",
              color: many === option.key ? "var(--color-ink)" : "var(--color-ink-3)",
            }}
          >
            {option.label}
          </button>
        ))}
      </div>

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

      {/*
        * Per row, not a count.
        *
        * "3 added" tells an operator nothing they cannot act on. Which three, and
        * what happened to the rest, is the answer they actually need - the
        * duplicates to delete from the list before re-pasting, and the plan-blocked
        * rows that need a plan change rather than a retry.
        *
        * The three lists stay apart because they are three different problems: a
        * duplicate is a typo to fix, a plan block is a purchase decision, and
        * folding them into one "some failed" is what makes a bulk import feel
        * like it did not work.
        */}
      {result ? (
        <div className="mt-4 border-t pt-3" style={{ borderColor: "var(--color-line)" }} data-testid="bulk-result">
          <p role="status" className="text-[13px]" style={{ color: "var(--color-pass)" }}>
            Added {result.created}
            {result.failed > 0 || result.planBlocked > 0
              ? ` · skipped ${result.failed + result.planBlocked}`
              : ""}
          </p>

          {result.domains.length > 0 ? (
            <ul className="mt-2.5 flex flex-col gap-1">
              {result.domains.map((d) => (
                <li key={d.domainId} className="flex flex-wrap items-baseline gap-x-2 text-[12.5px]">
                  <span className="num" style={{ color: "var(--color-ink)" }}>
                    {d.name}
                  </span>
                  <a
                    href={onboardingHref(d.slug)}
                    className="underline"
                    style={{ color: "var(--color-ink-2)" }}
                  >
                    set up DNS →
                  </a>
                </li>
              ))}
            </ul>
          ) : null}

          {[...result.failures, ...result.planLimitRejections].length > 0 ? (
            <ul className="mt-2.5 flex flex-col gap-1">
              {[...result.failures, ...result.planLimitRejections].map((f, i) => (
                <li
                  key={`${f.index}-${f.name}-${i}`}
                  className="text-[12.5px]"
                  style={{ color: "var(--color-ink-3)" }}
                >
                  <span className="num">{f.name}</span> — {f.reason}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap items-end gap-3">
        {many ? (
          <div className="min-w-[260px] flex-1">
            <Field label="Domains, one per line">
              <textarea
                value={pasted}
                onChange={(e) => setPasted(e.target.value)}
                rows={7}
                placeholder={"acme-one.com\nacme-two.com\nacme-three.com"}
                data-testid="bulk-domain-input"
              />
            </Field>
          </div>
        ) : (
          <div className="min-w-[260px] flex-1">
            <Field label="Domain">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                required={!many}
                minLength={3}
                placeholder="example.com"
                data-testid="domain-name"
              />
            </Field>
          </div>
        )}
        <ActionButton
          type="submit"
          label={many ? `Add ${lines.length} domain${lines.length === 1 ? "" : "s"}` : "Add domain"}
          loadingLabel={many ? "Adding…" : "Adding…"}
          busy={busy}
          disabled={many ? lines.length === 0 : !name.trim()}
          testId="add-domain"
        />
      </div>
      {many ? (
        <p className="mt-2 text-[11.5px]" style={{ color: "var(--color-ink-3)" }}>
          One per line. Blank lines and duplicates are skipped. Each is created
          PENDING and needs its own DNS record afterwards.
        </p>
      ) : null}
    </form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="label">{label}</span>
      {children}
      <style>{`
        label input:not([type="checkbox"]),
        label textarea {
          background: var(--color-elevate);
          border: 1px solid var(--color-line-strong);
          border-radius: 2px;
          color: var(--color-ink);
          padding: 8px 11px;
          font-size: 14px;
          outline: revert;
          width: 100%;
        }
        /* The paste box is monospace: a domain list is machine text being
           corrected by eye, and a proportional face makes "acme-one.com" and
           "acme-one .corn" harder to tell apart than it should be. */
        label textarea {
          font-family: var(--font-inter), ui-monospace, monospace;
          font-size: 13px;
          line-height: 1.7;
          resize: vertical;
        }
      `}</style>
    </label>
  );
}
