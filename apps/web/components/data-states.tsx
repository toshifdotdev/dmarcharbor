"use client";

/**
 * data-states.tsx — the three states every fetching screen needs.
 *
 * A slow connection is the normal case on this machine (2-11s per call), and a
 * slow call that reads as a broken page is a support ticket. So:
 *
 *   loading — a waiting state that looks like waiting (Tide, the brand loader)
 *   empty   — loaded, nothing here, and WHAT TO DO NEXT (a first run is not
 *             an absence)
 *   failed  — what failed and a retry, and it must never look like empty:
 *             "you have no domains" when we could not load them is a lie that
 *             costs someone an afternoon.
 */

import { useRouter } from "next/navigation";
import { TideMark } from "@/components/posture";

/**
 * The mark alone, centred, with no border around it and no word beside it.
 *
 * It used to be a bordered panel with the word "Loading" next to the mark, which
 * read as a small widget that had failed to fill rather than a page that was
 * waiting. The wave is the signal and it is already animated, so the box and the
 * label were both saying what the mark says on its own.
 *
 * The label is kept for screen readers as sr-only text: an accessible name has to
 * exist, but a sighted user does not need to be told in words what an animated
 * mark already shows.
 */
export function LoadingState({ label = "Loading" }: { label?: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="state-loading"
      className="flex items-center justify-center py-12"
    >
      <span className="sr-only">{label}</span>
      <TideMark />
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: { label: string; onClick?: () => void; href?: string };
}) {
  return (
    <div
      role="status"
      data-testid="state-empty"
      className="rounded-[2px] border px-5 py-10 text-center"
      style={{
        background: "var(--color-surface)",
        borderColor: "var(--color-line)",
      }}
    >
      <p className="text-[15px] font-semibold" style={{ color: "var(--color-ink)" }}>
        {title}
      </p>
      <p className="mx-auto mt-2 max-w-[52ch] text-[13px]" style={{ color: "var(--color-ink-2)" }}>
        {description}
      </p>
      {action ? (
        action.href ? (
          <a
            href={action.href}
            className="mt-4 inline-block rounded-[2px] px-4 py-2 text-[13px] font-semibold"
            style={{ background: "var(--color-accent)", color: "var(--color-accent-ink)" }}
          >
            {action.label}
          </a>
        ) : (
          <button
            type="button"
            onClick={action.onClick}
            className="mt-4 rounded-[2px] px-4 py-2 text-[13px] font-semibold"
            style={{ background: "var(--color-accent)", color: "var(--color-accent-ink)" }}
          >
            {action.label}
          </button>
        )
      ) : null}
    </div>
  );
}

export function ErrorState({
  what,
  detail,
}: {
  what: string;
  detail?: string;
}) {
  const router = useRouter();
  return (
    <div
      role="alert"
      data-testid="state-error"
      className="rounded-[2px] border px-5 py-8"
      style={{
        background: "var(--color-block-soft)",
        borderColor: "var(--color-block)",
      }}
    >
      <p
        className="num text-[11px] font-semibold tracking-[0.12em] uppercase"
        style={{ color: "var(--color-block)" }}
      >
        Could not load
      </p>
      <p className="mt-2 text-[14px]" style={{ color: "var(--color-ink)" }}>
        {what} did not load: the measurement API did not answer in time.
      </p>
      {detail ? (
        <p className="mt-1.5 text-[12.5px]" style={{ color: "var(--color-ink-2)" }}>
          {detail}
        </p>
      ) : null}
      <p className="mt-1.5 text-[12px]" style={{ color: "var(--color-ink-3)" }}>
        This is not the same as having no data: the request simply failed.
        Nothing was deleted or hidden.
      </p>
      <button
        type="button"
        onClick={() => router.refresh()}
        data-testid="state-retry"
        className="mt-4 rounded-[2px] px-4 py-2 text-[13px] font-semibold"
        style={{ background: "var(--color-accent)", color: "var(--color-accent-ink)" }}
      >
        Try again
      </button>
    </div>
  );
}
