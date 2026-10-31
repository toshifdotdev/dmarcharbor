"use client";

/**
 * toast.tsx — transient confirmation of something that already happened.
 *
 * A toast never carries the only copy of an important message: a failure that
 * needs a decision is shown inline, next to the control, and the toast at most
 * echoes it. Toasts are for "Scan recorded", "Link copied".
 *
 * Polite live region for confirmations, assertive for failures. Each stays six
 * seconds, longer while the pointer or focus is on it, and can be dismissed.
 */

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { clsx } from "clsx";
import { Close } from "./icons";

type ToastTone = "neutral" | "ok" | "fail";
interface ToastItem {
  id: number;
  title: string;
  body?: string;
  tone: ToastTone;
}

const ToastContext = createContext<((t: Omit<ToastItem, "id" | "tone"> & { tone?: ToastTone }) => void) | null>(null);

export function useToast() {
  const ctx = useContext(ToastContext);
  // Outside a provider a toast is a no-op rather than a crash: the inline
  // message is the record, the toast only an echo.
  return ctx ?? (() => {});
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);

  const push = useCallback((t: Omit<ToastItem, "id" | "tone"> & { tone?: ToastTone }) => {
    seq.current += 1;
    const item: ToastItem = { id: seq.current, tone: t.tone ?? "neutral", title: t.title, body: t.body };
    setItems((prev) => [...prev.slice(-2), item]);
  }, []);

  const dismiss = useCallback((id: number) => setItems((prev) => prev.filter((i) => i.id !== id)), []);

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div
        role="region"
        aria-label="Notifications"
        // --hb-dock: the app shell's question launcher keeps the corner, so
        // toasts rise above it. Unset (public pages), they sit at 16px.
        className="pointer-events-none fixed bottom-[calc(16px+var(--hb-dock,0px))] right-4 z-50 flex w-[min(380px,calc(100vw-32px))] flex-col gap-2"
      >
        <div aria-live="polite" className="flex flex-col gap-2">
          {items
            .filter((i) => i.tone !== "fail")
            .map((i) => (
              <Toast key={i.id} item={i} onDismiss={dismiss} />
            ))}
        </div>
        <div aria-live="assertive" className="flex flex-col gap-2">
          {items
            .filter((i) => i.tone === "fail")
            .map((i) => (
              <Toast key={i.id} item={i} onDismiss={dismiss} />
            ))}
        </div>
      </div>
    </ToastContext.Provider>
  );
}

function Toast({ item, onDismiss }: { item: ToastItem; onDismiss: (id: number) => void }) {
  const [held, setHeld] = useState(false);

  useEffect(() => {
    if (held) return;
    const timer = setTimeout(() => onDismiss(item.id), 6000);
    return () => clearTimeout(timer);
  }, [held, item.id, onDismiss]);

  return (
    <div
      className={clsx(
        "pointer-events-auto flex items-start gap-3 rounded-[12px] border bg-paper py-3 pl-3.5 pr-2 shadow-float",
        "[animation:hb-rise_160ms_ease-out]",
        item.tone === "fail" ? "border-fail/40" : "border-rule-2",
      )}
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
    >
      <span
        aria-hidden
        className={clsx(
          "mt-[5px] block size-2 shrink-0",
          item.tone === "ok" && "bg-ok",
          item.tone === "fail" && "rotate-45 bg-fail",
          item.tone === "neutral" && "bg-fg-3",
        )}
      />
      <div className="min-w-0 flex-1">
        <p className="text-ui font-semibold text-fg">{item.title}</p>
        {item.body ? <p className="mt-0.5 text-meta text-fg-2">{item.body}</p> : null}
      </div>
      <button
        type="button"
        onClick={() => onDismiss(item.id)}
        aria-label="Dismiss"
        className="grid size-6 shrink-0 place-items-center rounded-full text-fg-3 hover:bg-paper-3 hover:text-fg"
      >
        <Close size={12} />
      </button>
    </div>
  );
}
