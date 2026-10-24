"use client";

/**
 * parts.tsx — the pieces every settings section is built from.
 *
 *   Panel       one decision on the page: a heading, a line on why it matters,
 *               the controls. Sections are a stack of these, not a form.
 *   DangerZone  where an action cannot be taken back. A fail-coloured rule and a
 *               plain statement of what is lost, set apart from everything else
 *               on the page so it is never next to a harmless button. Not a red
 *               box: the words carry the weight, the colour only marks the edge.
 *   OnceSecret  a value the API returns once (an API key, a signing secret, a
 *               TXT token). It arrives with motion so it is noticed, says it
 *               will not be shown again, and leaves only when dismissed.
 */

import type { ReactNode } from "react";
import { clsx } from "clsx";
import { Button } from "@/components/ui/button";
import { CopyValue } from "@/components/ui/copy";

export function Panel({
  title,
  why,
  aside,
  id,
  children,
  className,
  testId,
}: {
  title: ReactNode;
  /** Why this decision matters, in a sentence. */
  why?: ReactNode;
  aside?: ReactNode;
  id?: string;
  children?: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <section aria-labelledby={id} data-testid={testId} className={clsx("flex flex-col gap-3", className)}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-rule-2 pb-2">
        <div className="min-w-0">
          <h2 id={id} className="text-h3 font-bold tracking-[-0.01em] text-fg">
            {title}
          </h2>
          {why ? <p className="mt-0.5 max-w-[72ch] text-ui text-fg-2">{why}</p> : null}
        </div>
        {aside ? <div className="text-meta text-fg-3">{aside}</div> : null}
      </div>
      {children}
    </section>
  );
}

export function DangerZone({
  title,
  consequence,
  children,
  testId,
}: {
  title: ReactNode;
  /** What is lost, said plainly. Shown before the control, always. */
  consequence: ReactNode;
  children?: ReactNode;
  testId?: string;
}) {
  return (
    <section data-testid={testId} className="mt-4 flex flex-col gap-3 border-t-2 border-fail/70 pt-3">
      <div>
        <p className="legend flex items-center gap-1.5 text-fail!">
          <span aria-hidden className="size-[7px] rotate-45 bg-fail" />
          Cannot be undone
        </p>
        <h2 className="mt-1 text-h3 font-bold tracking-[-0.01em] text-fg">{title}</h2>
        <div className="mt-1 max-w-[72ch] text-ui text-fg-2">{consequence}</div>
      </div>
      {children}
    </section>
  );
}

export function OnceSecret({
  title,
  value,
  label,
  children,
  onDismiss,
  dismissLabel = "I have stored it",
  testId,
  dismissTestId,
}: {
  title: ReactNode;
  value: string;
  /** Names the value for the copy button: "API key". */
  label: string;
  children?: ReactNode;
  onDismiss: () => void;
  dismissLabel?: string;
  testId?: string;
  dismissTestId?: string;
}) {
  return (
    <div
      role="status"
      data-testid={testId}
      className="flex flex-col gap-3 rounded-ctl border border-act/40 bg-paper-2 px-4 py-3.5 shadow-[0_0_0_3px_var(--color-act-line)] [animation:hb-rise_240ms_ease-out]"
    >
      <div>
        <p className="legend text-act!">Shown once</p>
        <p className="mt-0.5 text-body font-semibold text-fg">{title}</p>
      </div>
      <CopyValue value={value} label={label} />
      {children ? <div className="text-ui text-fg-2">{children}</div> : null}
      <div>
        <Button variant="primary" size="sm" onClick={onDismiss} data-testid={dismissTestId}>
          {dismissLabel}
        </Button>
      </div>
    </div>
  );
}

/** A count with its noun, pluralised: "3 domains", "1 domain". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-GB")} ${n === 1 ? one : many}`;
}
