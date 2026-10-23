"use client";

/**
 * copy.tsx — copying exact values, and DNS records laid out to be published.
 *
 * Operators paste these into a DNS provider's form, where one wrong character
 * is a silent failure two days later. So the value is shown whole (wrapped,
 * never truncated), in the data face that keeps 0/O and 1/l apart, and copied
 * exactly. A failed clipboard write selects the text instead, so the person
 * can still copy it by hand, and says so.
 */

import { useRef, useState } from "react";
import { clsx } from "clsx";

export function CopyButton({
  value,
  label = "Copy",
  className,
  testId,
}: {
  value: string;
  /** Accessible name, e.g. "Copy TXT value". */
  label?: string;
  className?: string;
  testId?: string;
}) {
  const [state, setState] = useState<"idle" | "copied" | "manual">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function copy(e: React.MouseEvent<HTMLButtonElement>) {
    if (timer.current) clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(value);
      setState("copied");
    } catch {
      // Select the nearest value so a manual copy is one keystroke away.
      const target = e.currentTarget.closest("[data-copy-scope]")?.querySelector("[data-copy-value]");
      if (target) {
        const range = document.createRange();
        range.selectNodeContents(target);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
      setState("manual");
    }
    timer.current = setTimeout(() => setState("idle"), 2400);
  }

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={label}
      data-testid={testId}
      className={clsx(
        "inline-flex h-6 shrink-0 items-center rounded-[2px] border px-2 text-meta font-semibold transition-colors duration-75",
        state === "copied" ? "border-ok/40 text-ok" : "border-rule-2 bg-paper-2 text-fg-2 hover:border-fg-3 hover:text-fg",
        className,
      )}
    >
      <span aria-live="polite">{state === "copied" ? "Copied" : state === "manual" ? "Selected: press Ctrl C" : "Copy"}</span>
    </button>
  );
}

/** One value an operator must reproduce exactly, with its copy control. */
export function CopyValue({ value, label, className }: { value: string; label: string; className?: string }) {
  return (
    <div data-copy-scope className={clsx("flex items-start gap-2 rounded-ctl border border-rule bg-paper-3 py-1.5 pl-2.5 pr-1.5", className)}>
      <code data-copy-value className="data min-w-0 flex-1 break-all pt-[3px] text-meta text-fg">
        {value}
      </code>
      <CopyButton value={value} label={`Copy ${label}`} />
    </div>
  );
}

/**
 * A DNS record to publish: type, host and value, each copyable. Host is shown
 * both as the full name and as the label most DNS forms want relative to the
 * zone, because "_dmarc" versus "_dmarc.example.com" is the most common
 * mistake in this whole job.
 */
export function DnsRecord({
  type,
  host,
  zone,
  value,
  note,
  testId,
}: {
  type: "TXT" | "CNAME" | "MX";
  host: string;
  /** The domain itself, to derive the relative label. */
  zone?: string;
  value: string;
  note?: React.ReactNode;
  testId?: string;
}) {
  const relative =
    zone && host.toLowerCase().endsWith(`.${zone.toLowerCase()}`) ? host.slice(0, -(zone.length + 1)) : null;
  return (
    <section data-testid={testId} className="border-y border-rule">
      <dl className="grid grid-cols-[72px_minmax(0,1fr)] gap-x-4">
        <dt className="legend border-b border-rule py-2">Type</dt>
        <dd className="data border-b border-rule py-2 text-meta font-semibold text-fg">{type}</dd>
        <dt className="legend border-b border-rule py-2">Host</dt>
        <dd className="border-b border-rule py-1.5">
          <CopyValue value={host} label={`${type} host`} />
          {relative ? (
            <p className="mt-1 text-meta text-fg-3">
              Many DNS forms want only <code className="data text-fg-2">{relative}</code>: they add the domain themselves.
            </p>
          ) : null}
        </dd>
        <dt className="legend py-2">Value</dt>
        <dd className="py-1.5">
          <CopyValue value={value} label={`${type} value`} />
        </dd>
      </dl>
      {note ? <p className="border-t border-rule py-2 text-meta text-fg-3">{note}</p> : null}
    </section>
  );
}
