"use client";

/**
 * dialog.tsx — modal dialog and side sheet on the native <dialog> element.
 *
 * showModal() gives us, from the platform: focus moved into the dialog, the
 * rest of the page inert, Escape to close, focus returned on close, and a
 * top layer that no z-index can fight. Rebuilding that by hand is how focus
 * traps leak.
 *
 * A click on the backdrop closes. A click that starts inside and ends outside
 * (selecting text in a field, say) does not, because the check is on the
 * pointerdown target as well as the click target.
 */

import { useEffect, useId, useRef, type ReactNode } from "react";
import { clsx } from "clsx";
import { Button } from "./button";
import { Close } from "./icons";

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  variant = "center",
  className,
  testId,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  /** "sheet" slides in from the left edge: the mobile navigation. */
  variant?: "center" | "sheet";
  className?: string;
  testId?: string;
}) {
  const ref = useRef<HTMLDialogElement | null>(null);
  const downOnBackdrop = useRef(false);
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      data-testid={open ? testId : undefined}
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
      className={clsx("hb-dialog", variant === "sheet" && "hb-sheet", className)}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onPointerDown={(e) => {
        downOnBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (downOnBackdrop.current && e.target === e.currentTarget) onClose();
      }}
    >
      {open ? (
        <div className={clsx("flex flex-col", variant === "sheet" && "h-full")}>
          <header className="flex items-start gap-4 border-b border-rule px-5 py-4">
            <div className="min-w-0 flex-1">
              <h2 id={titleId} className="text-h3 font-semibold">
                {title}
              </h2>
              {description ? (
                <p id={descId} className="mt-1 text-ui text-fg-2">
                  {description}
                </p>
              ) : null}
            </div>
            <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close" className="-mr-2 -mt-1 px-1.5">
              <Close size={14} />
            </Button>
          </header>
          {children ? (
            <div className={clsx("px-5 py-4", variant === "sheet" && "flex-1 overflow-y-auto px-3")}>{children}</div>
          ) : null}
          {footer ? (
            <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-rule bg-paper px-5 py-3">
              {footer}
            </footer>
          ) : null}
        </div>
      ) : null}
    </dialog>
  );
}

/**
 * A destructive or consequential action, confirmed. The confirm button names
 * the action ("Revoke link"), never "OK"; the body says what will happen and
 * whether it can be undone.
 */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  body,
  confirmLabel,
  busy,
  danger,
  error,
  testId,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: ReactNode;
  body: ReactNode;
  confirmLabel: string;
  busy?: boolean;
  danger?: boolean;
  error?: ReactNode;
  /** The control's own id: the open dialog is `${testId}-confirm`, its
   *  confirm button `${testId}-confirm-button`. */
  testId?: string;
}) {
  return (
    <Dialog
      open={open}
      onClose={busy ? () => {} : onClose}
      title={title}
      testId={testId ? `${testId}-confirm` : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant={danger ? "danger" : "primary"}
            onClick={onConfirm}
            busy={busy}
            busyLabel={confirmLabel}
            data-testid={testId ? `${testId}-confirm-button` : undefined}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="text-body text-fg-2">{body}</div>
      {error ? (
        <p role="alert" className="mt-3 text-ui font-medium text-fail">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}
