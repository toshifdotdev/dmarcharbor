"use client";

/**
 * workspace-setup.tsx — naming a workspace, and accepting what it runs under.
 *
 * The slug follows the name as you type (lowercase, hyphens) until you edit it
 * yourself, and the address it becomes part of is shown, so nobody has to
 * invent a slug from a rule they have not been told.
 *
 * Three boxes, all required, none pre-ticked: the Terms of Service, then the
 * two Data Processing Agreement confirmations (read and accepted, and
 * authorised to accept for the organisation). The server action refuses
 * without all three and sends them on the creation call itself, so a
 * workspace can never exist without its acceptance record. Field names are
 * the action's contract (and the clickthrough suite's): name, slug,
 * tos-accept, dpa-accept, dpa-authorised.
 */

import Link from "next/link";
import { useActionState, useState } from "react";
import { clsx } from "clsx";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";

export type WorkspaceFormState = {
  error: string | null;
  field: "name" | "slug" | "dpa" | "tos" | null;
};

export function slugFrom(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
}

export function WorkspaceSetup({
  action,
  disableSubmit = false,
  limitReason,
}: {
  action: (state: WorkspaceFormState, formData: FormData) => Promise<WorkspaceFormState>;
  /** No allowance left: the form stays readable, the button explains. */
  disableSubmit?: boolean;
  limitReason?: string | null;
}) {
  const [state, formAction, pending] = useActionState(action, { error: null, field: null });
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [ticks, setTicks] = useState({ tos: false, read: false, auth: false });

  const effectiveSlug = slugTouched ? slug : slugFrom(name);
  const slugValid = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(effectiveSlug);
  const allTicked = ticks.tos && ticks.read && ticks.auth;

  return (
    <form action={formAction} className="flex flex-col gap-6">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="ws-name" className="text-meta font-semibold text-fg-2">
          Workspace name
        </label>
        <input
          id="ws-name"
          name="name"
          required
          minLength={2}
          maxLength={80}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Your agency's name"
          autoFocus
          aria-invalid={state.field === "name" || undefined}
          className="h-10 w-full rounded-ctl border border-rule-2 bg-paper-2 px-3 text-body text-fg placeholder:text-fg-4 hover:border-fg-4 focus-visible:border-act focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-act-line aria-[invalid=true]:border-fail"
        />
        <p className="text-meta text-fg-3">Usually your agency or MSP. Clients and their domains live inside it.</p>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="ws-slug" className="text-meta font-semibold text-fg-2">
          Slug
        </label>
        <input
          id="ws-slug"
          name="slug"
          required
          minLength={2}
          pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
          value={effectiveSlug}
          onChange={(e) => {
            setSlugTouched(true);
            setSlug(e.target.value.toLowerCase());
          }}
          aria-invalid={state.field === "slug" || (effectiveSlug.length > 0 && !slugValid) || undefined}
          spellCheck={false}
          className="data h-10 w-full rounded-ctl border border-rule-2 bg-paper-2 px-3 text-body text-fg hover:border-fg-4 focus-visible:border-act focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-act-line aria-[invalid=true]:border-fail"
        />
        <p className="text-meta text-fg-3">
          {effectiveSlug.length > 0 && !slugValid
            ? "Lowercase letters, digits and single hyphens only."
            : slugTouched
              ? "Set by you. It identifies the workspace and cannot clash with another."
              : "Follows the name until you change it."}
        </p>
      </div>

      <fieldset className="flex flex-col gap-3 border-t border-rule pt-5">
        <legend className="sr-only">Agreements</legend>
        <p className="text-ui font-semibold text-fg">Before the workspace is created</p>
        <Tick name="tos-accept" checked={ticks.tos} onChange={(v) => setTicks((t) => ({ ...t, tos: v }))} invalid={state.field === "tos"}>
          I have read and accept the{" "}
          <Link href="/terms" target="_blank" className="link">
            Terms of Service
          </Link>
          .
        </Tick>
        <Tick name="dpa-accept" checked={ticks.read} onChange={(v) => setTicks((t) => ({ ...t, read: v }))} invalid={state.field === "dpa"}>
          I have read and accept the{" "}
          <Link href="/dpa" target="_blank" className="link">
            Data Processing Agreement
          </Link>
          .
        </Tick>
        <Tick name="dpa-authorised" checked={ticks.auth} onChange={(v) => setTicks((t) => ({ ...t, auth: v }))} invalid={state.field === "dpa"}>
          I am authorised to accept these on behalf of this organisation.
        </Tick>
        <p className="text-meta text-fg-3">
          Both documents open in a new tab. The acceptance is recorded against this workspace with the document version.
        </p>
      </fieldset>

      {state.error ? <Notice tone="fail" title={state.error} /> : null}
      {disableSubmit && limitReason ? <Notice tone="warn" title={limitReason} /> : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          variant="primary"
          size="lg"
          busy={pending}
          busyLabel="Creating the workspace"
          disabled={disableSubmit || !allTicked || name.trim().length < 2 || !slugValid}
        >
          {disableSubmit ? "Workspace limit reached" : "Create workspace"}
        </Button>
        {!allTicked && !disableSubmit ? (
          <span className="text-meta text-fg-3">
            {3 - Number(ticks.tos) - Number(ticks.read) - Number(ticks.auth)} box
            {3 - Number(ticks.tos) - Number(ticks.read) - Number(ticks.auth) === 1 ? "" : "es"} left to tick
          </span>
        ) : null}
      </div>
    </form>
  );
}

function Tick({
  name,
  checked,
  onChange,
  invalid,
  children,
}: {
  name: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  invalid?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className={clsx("flex cursor-pointer items-start gap-2.5 text-ui text-fg-2", invalid && !checked && "text-fail")}>
      <span className="relative mt-[2px] grid size-4 shrink-0 place-items-center">
        <input
          type="checkbox"
          name={name}
          required
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          className="peer size-4 appearance-none rounded-[3px] border border-rule-2 bg-paper-2 checked:border-act checked:bg-act hover:border-fg-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-act"
        />
        {checked ? (
          <svg viewBox="0 0 16 16" className="hb-draw-check pointer-events-none absolute size-3 text-act-ink" aria-hidden>
            <path d="M3.5 8.5 6.5 11.5 12.5 4.5" fill="none" stroke="currentColor" strokeWidth="2" />
          </svg>
        ) : null}
      </span>
      <span>{children}</span>
    </label>
  );
}
