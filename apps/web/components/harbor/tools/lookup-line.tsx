"use client";

/**
 * lookup-line.tsx — the query line every lookup tool shares: the DNS name
 * being read, typed into the record name itself (TXT _dmarc. + the domain),
 * and one primary button. Below it, one status line: what was read, a pause
 * when the shared lookup is rate limited, or why it could not run.
 *
 * Same shape as the home page's check, at the size of a tool page.
 */

import { useRef, type FormEvent, type ReactNode } from "react";
import { clsx } from "clsx";
import { Button } from "@/components/ui/button";
import { retryAfterText } from "@/lib/retry-after";
import type { ScanState } from "./scan";

export function LookupLine({
  id,
  prefix,
  value,
  onChange,
  onSubmit,
  busy,
  submitLabel,
  busyLabel,
  placeholder = "yourclient.example",
  inputLabel = "Domain to read",
  before,
  disabled,
}: {
  id: string;
  /** The fixed part of the name, e.g. "TXT _dmarc.". */
  prefix: ReactNode;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  busy: boolean;
  submitLabel: string;
  busyLabel: string;
  placeholder?: string;
  inputLabel?: string;
  /** A field set before the domain on the same line (the DKIM selector). */
  before?: ReactNode;
  disabled?: boolean;
}) {
  const input = useRef<HTMLInputElement | null>(null);
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!busy) onSubmit();
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-3 min-[900px]:flex-row">
      <label
        htmlFor={id}
        onClick={() => input.current?.focus()}
        className={clsx(
          "flex h-14 w-full min-w-0 shrink-0 cursor-text items-center min-[900px]:w-auto min-[900px]:flex-1 rounded-full border-[1.5px] border-rule-2 bg-paper pl-[22px] pr-3",
          "transition-colors duration-[120ms] hover:border-fg-4",
          "focus-within:border-fg focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-fg",
        )}
      >
        <span aria-hidden className="data shrink-0 whitespace-nowrap text-[16px] text-fg-4 sm:text-[17px]">
          {prefix}
        </span>
        {before}
        <span className="sr-only">{inputLabel}</span>
        <input
          ref={input}
          id={id}
          type="text"
          inputMode="url"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          data-testid={`${id}-input`}
          className="data h-full min-w-0 flex-1 border-0 bg-transparent text-[16px] text-fg outline-none placeholder:text-fg-4 focus-visible:outline-none sm:text-[17px]"
        />
      </label>
      <Button
        type="submit"
        variant="primary"
        busy={busy}
        busyLabel={busyLabel}
        disabled={disabled || !value.trim()}
        data-testid={`${id}-submit`}
        className="h-14! shrink-0 px-7! text-[16.5px]!"
      >
        {submitLabel}
      </Button>
    </form>
  );
}

/** One line under the query: what was read, a pause, or why the lookup could not run. */
export function LookupStatus({ state, read, idle }: { state: ScanState; read: ReactNode; idle: ReactNode }) {
  return (
    <div aria-live="polite" className="min-h-[40px] pt-2.5 text-[13.5px] leading-[18px]">
      {state.phase === "paused" ? (
        <p role="status" className="font-semibold text-warn">
          Too many lookups from this network just now. {retryAfterText(state.wait)} The lookup is shared, which is why it
          stays free.
        </p>
      ) : state.phase === "failed" ? (
        <p role="alert" className="font-semibold text-fail">
          {state.message}
        </p>
      ) : state.phase === "done" ? (
        <p className="text-fg-4">{read}</p>
      ) : (
        <p className="text-fg-4">{idle}</p>
      )}
    </div>
  );
}

/** A figure head, the way the hero map has one: bold name, lighter meta, hairline. */
export function FigureHead({ name, meta, className }: { name: ReactNode; meta?: ReactNode; className?: string }) {
  return (
    <div className={clsx("flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-rule pb-3", className)}>
      <span className="text-[17px] font-bold text-fg">{name}</span>
      {meta ? <span className="text-[14px] text-fg-4">{meta}</span> : null}
    </div>
  );
}

