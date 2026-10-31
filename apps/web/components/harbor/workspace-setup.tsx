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
import { Checkbox } from "@/components/ui/choice";
import { Input } from "@/components/ui/field";
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

  const left = 3 - Number(ticks.tos) - Number(ticks.read) - Number(ticks.auth);

  return (
    <form action={formAction} className="flex flex-col gap-6">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="ws-name" className="text-meta font-semibold text-fg-2">
          Workspace name
        </label>
        <Input
          id="ws-name"
          name="name"
          size="lg"
          required
          minLength={2}
          maxLength={80}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Your agency's name"
          autoFocus
          aria-invalid={state.field === "name" || undefined}
          aria-describedby="ws-name-hint"
        />
        <p id="ws-name-hint" className="text-meta text-fg-3">
          Usually your agency or MSP. Clients and their domains live inside it.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="ws-slug" className="text-meta font-semibold text-fg-2">
          Slug
        </label>
        <Input
          id="ws-slug"
          name="slug"
          size="lg"
          mono
          required
          minLength={2}
          pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
          value={effectiveSlug}
          onChange={(e) => {
            setSlugTouched(true);
            setSlug(e.target.value.toLowerCase());
          }}
          aria-invalid={state.field === "slug" || (effectiveSlug.length > 0 && !slugValid) || undefined}
          aria-describedby="ws-slug-hint"
          spellCheck={false}
        />
        <p id="ws-slug-hint" className={clsx("text-meta", effectiveSlug.length > 0 && !slugValid ? "text-fail" : "text-fg-3")}>
          {effectiveSlug.length > 0 && !slugValid
            ? "Lowercase letters, digits and single hyphens only."
            : slugTouched
              ? "Set by you. It identifies the workspace and cannot clash with another."
              : "Follows the name until you change it."}
        </p>
      </div>

      <fieldset className="flex flex-col gap-3.5 border-t border-rule pt-5">
        <legend className="sr-only">Agreements</legend>
        <p className="text-ui">
          <span className="font-bold text-fg">Before the workspace is created</span>{" "}
          <span className="text-fg-3">three boxes, none ticked for you</span>
        </p>
        <Checkbox
          name="tos-accept"
          required
          checked={ticks.tos}
          onChange={(e) => setTicks((t) => ({ ...t, tos: e.target.checked }))}
          aria-invalid={(state.field === "tos" && !ticks.tos) || undefined}
          label={
            <>
              I have read and accept the{" "}
              <Link href="/terms" target="_blank" className="link">
                Terms of Service
              </Link>
              .
            </>
          }
        />
        <Checkbox
          name="dpa-accept"
          required
          checked={ticks.read}
          onChange={(e) => setTicks((t) => ({ ...t, read: e.target.checked }))}
          aria-invalid={(state.field === "dpa" && !ticks.read) || undefined}
          label={
            <>
              I have read and accept the{" "}
              <Link href="/dpa" target="_blank" className="link">
                Data Processing Agreement
              </Link>
              .
            </>
          }
        />
        <Checkbox
          name="dpa-authorised"
          required
          checked={ticks.auth}
          onChange={(e) => setTicks((t) => ({ ...t, auth: e.target.checked }))}
          aria-invalid={(state.field === "dpa" && !ticks.auth) || undefined}
          label="I am authorised to accept these on behalf of this organisation."
        />
        <p className="text-meta text-fg-3">
          Both documents open in a new tab. The acceptance is recorded against this workspace with the document version.
        </p>
      </fieldset>

      {state.error ? <Notice tone="fail" title={state.error} /> : null}
      {disableSubmit && limitReason ? <Notice tone="warn" title={limitReason} /> : null}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
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
          <span className="tnum text-meta text-fg-3">
            {left} box{left === 1 ? "" : "es"} left to tick
          </span>
        ) : null}
      </div>
    </form>
  );
}
