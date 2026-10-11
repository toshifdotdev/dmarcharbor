"use client";

import { useActionState } from "react";
import Link from "next/link";

/**
 * workspace-form.tsx — the create-workspace form on /welcome.
 *
 * Three boxes, all required, none pre-ticked: the Terms of Service, then the two
 * Data Processing Agreement confirmations (acceptance AND authority). The server
 * action refuses without all three, failing closed, and records each acceptance
 * against the workspace on the creation call itself — an acceptance nobody can
 * point at in the compliance chain is not evidence.
 *
 * The Terms box used to live on the billing page, which left two holes. A
 * customer on the free plan never reached billing, so they used the whole product
 * without ever seeing the document the service is provided under; and the paid
 * path could be reached by a caller that ignored the checkbox entirely, because
 * it existed only in React state and was never sent or checked. It belongs here,
 * beside the DPA, where it is sent and stored.
 */

export type WorkspaceFormState = {
  error: string | null;
  field: "name" | "slug" | "dpa" | "tos" | null;
};

export function WorkspaceForm({
  action,
}: {
  action: (state: WorkspaceFormState, formData: FormData) => Promise<WorkspaceFormState>;
}) {
  const [state, formAction, pending] = useActionState(action, {
    error: null,
    field: null,
  });

  const errorStyle = { color: "var(--color-block)" } as const;

  return (
    <form action={formAction} className="flex w-full max-w-sm flex-col gap-4">
      <label className="flex flex-col gap-1.5">
        <span className="label">Workspace name</span>
        <input
          name="name"
          required
          minLength={2}
          maxLength={80}
          placeholder="Example Agency"
          className="rounded-[2px] border px-3 py-2 text-[15px]"
          style={{
            background: "var(--color-surface)",
            borderColor: state.field === "name" ? "var(--color-block)" : "var(--color-line-strong)",
            color: "var(--color-ink)",
          }}
        />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="label">Slug</span>
        <input
          name="slug"
          required
          minLength={2}
          pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
          placeholder="example-agency"
          className="num rounded-[2px] border px-3 py-2 text-[14.5px]"
          style={{
            background: "var(--color-surface)",
            borderColor: state.field === "slug" ? "var(--color-block)" : "var(--color-line-strong)",
            color: "var(--color-ink)",
          }}
        />
      </label>
      {/* Three boxes, all required, none pre-ticked. The authority one is the
          one that matters: an employee signing up has not been authorised by
          their firm. */}
      <fieldset className="mt-1 flex flex-col gap-2.5">
        <legend className="label">Before you create the workspace</legend>
        <label className="flex items-start gap-2.5 text-[13px] leading-[1.6]" style={{ color: "var(--color-ink-2)" }}>
          <input type="checkbox" name="tos-accept" required className="mt-1" />
          <span>
            I have read and accept the{" "}
            <Link href="/terms" target="_blank" className="underline" style={{ color: "var(--color-ink)" }}>
              Terms of Service
            </Link>
            .
          </span>
        </label>
        <label className="flex items-start gap-2.5 text-[13px] leading-[1.6]" style={{ color: "var(--color-ink-2)" }}>
          <input type="checkbox" name="dpa-accept" required className="mt-1" />
          <span>
            I have read and accept the{" "}
            <Link href="/dpa" target="_blank" className="underline" style={{ color: "var(--color-ink)" }}>
              Data Processing Agreement
            </Link>
            .
          </span>
        </label>
        <label className="flex items-start gap-2.5 text-[13px] leading-[1.6]" style={{ color: "var(--color-ink-2)" }}>
          <input type="checkbox" name="dpa-authorised" required className="mt-1" />
          <span>
            I confirm I am authorised to accept on behalf of this organisation.
          </span>
        </label>
      </fieldset>
      {state.error ? (
        <p role="alert" className="text-[13px]" style={errorStyle}>
          {state.error}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={pending}
        className="mt-2 rounded-[2px] px-5 py-2.5 text-[14.5px] font-semibold disabled:cursor-not-allowed"
        style={{
          background: "var(--color-accent)",
          color: "var(--color-accent-ink)",
          opacity: pending ? 0.6 : 1,
        }}
      >
        {pending ? "Creating…" : "Create workspace"}
      </button>
    </form>
  );
}
