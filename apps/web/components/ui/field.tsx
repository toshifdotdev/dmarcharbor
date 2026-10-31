"use client";

/**
 * field.tsx — inputs, selects, and the label/hint/error frame around them.
 *
 * The select is the NATIVE element, styled. A custom listbox would have to
 * re-earn everything the platform already gives: type-ahead, the mobile picker,
 * screen reader support, form participation. The chevron is drawn over it and
 * ignores the pointer.
 *
 * Field wires the ids itself: the label names the control, the hint and the
 * error describe it, and an error sets aria-invalid. A control with an error
 * that a screen reader cannot hear is not an error state.
 *
 * Routes: white controls on a hairline, an ink border and a soft ring on focus.
 * Search fields are pills, like the home page's record check.
 */

import { cloneElement, isValidElement, useId, type InputHTMLAttributes, type ReactElement, type ReactNode, type Ref, type SelectHTMLAttributes } from "react";
import { clsx } from "clsx";
import { ChevronDown, Search } from "./icons";

const control =
  "w-full rounded-ctl border border-rule-2 bg-paper text-fg placeholder:text-fg-4 " +
  "transition-[border-color,box-shadow] duration-100 " +
  "hover:border-fg-4 focus-visible:border-act focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-act-line/35 " +
  "disabled:cursor-not-allowed disabled:bg-paper-3 disabled:text-fg-3 " +
  "aria-[invalid=true]:border-fail aria-[invalid=true]:ring-fail/20";

const controlSize = {
  sm: "h-[30px] px-2.5 text-meta",
  md: "h-9 px-3 text-ui",
  lg: "h-11 px-3.5 text-body",
} as const;

export function Input({
  size = "md",
  className,
  mono,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, "size"> & {
  size?: keyof typeof controlSize;
  /** Domains, records, tokens: anything an operator types exactly. */
  mono?: boolean;
  /** React 19 passes ref as a prop; it lands on the input. */
  ref?: Ref<HTMLInputElement>;
}) {
  return <input className={clsx(control, controlSize[size], mono && "data", className)} {...rest} />;
}

export function SearchInput({
  size = "md",
  className,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, "size" | "type"> & { size?: keyof typeof controlSize }) {
  return (
    <span className={clsx("relative inline-flex items-center", className)}>
      <Search className="pointer-events-none absolute left-3 text-fg-3" size={14} />
      <input type="search" className={clsx(control, controlSize[size], "rounded-full pl-8")} {...rest} />
    </span>
  );
}

export function Select({
  size = "md",
  className,
  children,
  ...rest
}: Omit<SelectHTMLAttributes<HTMLSelectElement>, "size"> & { size?: keyof typeof controlSize }) {
  return (
    <span className={clsx("relative inline-flex items-center", className)}>
      <select className={clsx(control, controlSize[size], "appearance-none pr-8")} {...rest}>
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2.5 text-fg-3" size={14} />
    </span>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  /** One control. Its id and aria wiring are set here. */
  children: ReactElement<{ id?: string; "aria-describedby"?: string; "aria-invalid"?: boolean }>;
  className?: string;
}) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  const wired = isValidElement(children)
    ? cloneElement(children, {
        id,
        "aria-describedby": describedBy,
        // Only an error sets it; without one, the control keeps its own value
        // (a field can be marked invalid while its hint carries a warning).
        ...(error ? { "aria-invalid": true } : {}),
      })
    : children;
  return (
    <div className={clsx("flex flex-col gap-1.5", className)}>
      <label htmlFor={id} className="text-meta font-semibold text-fg-2">
        {label}
      </label>
      {wired}
      {hint ? (
        <p id={hintId} className="text-meta text-fg-3">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="text-meta font-medium text-fail">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Segmented control: two to four mutually exclusive views of the same data.
 * A radio group underneath, so arrow keys move between options natively. A
 * pill track; the chosen option is filled in the accent, like the station a
 * line stops at.
 */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  size = "md",
}: {
  label: string;
  value: T;
  options: Array<{ value: T; label: ReactNode }>;
  onChange: (value: T) => void;
  size?: "sm" | "md";
}) {
  const name = useId();
  return (
    <fieldset className="inline-flex rounded-full border border-rule-2 bg-paper p-[3px]">
      <legend className="sr-only">{label}</legend>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <label
            key={o.value}
            className={clsx(
              "relative inline-flex cursor-pointer items-center rounded-full font-semibold transition-colors duration-100",
              "has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-act",
              size === "sm" ? "h-[26px] px-3 text-meta" : "h-[30px] px-3.5 text-ui",
              on ? "bg-act text-act-ink" : "text-fg-3 hover:text-fg",
            )}
          >
            <input
              type="radio"
              name={name}
              value={o.value}
              checked={on}
              onChange={() => onChange(o.value)}
              className="sr-only"
            />
            {o.label}
          </label>
        );
      })}
    </fieldset>
  );
}
