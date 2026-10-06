"use client";

import { useActionState } from "react";
import Link from "next/link";

/**
 * workspace-form.tsx — the create-workspace form on /welcome.
 *
 * Two boxes, both required, neither pre-ticked: acceptance AND authority. The
 * server action refuses without both (fail closed: an unchecked box is a
 * refusal, never a silent success) and records the acceptance through
 * POST /api/workspaces/:id/dpa-acceptance, because an acceptance nobody can
 * point at in the compliance chain is not evidence.
 *
 * Errors are inline and named: a duplicate slug or a refused acceptance shows
 * the reason on the form. It never replaces the whole app with an error page.
 */

export type WorkspaceFormState = {
  error: string | null;
  field: "name" | "slug" | "dpa" | null;
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
      {/* Two boxes, both required, neither pre-ticked. The second is the one
          that matters: an employee signing up has not been authorised by their
          firm. */}
      <fieldset className="mt-1 flex flex-col gap-2.5">
        <legend className="label">Before you create the workspace</legend>
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
