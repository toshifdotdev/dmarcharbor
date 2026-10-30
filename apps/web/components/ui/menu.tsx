"use client";

/**
 * menu.tsx — dropdown menus, styled once.
 *
 * Radix supplies the behaviour (roving focus, type-ahead, Escape, focus return,
 * collision handling); this file supplies the look, so the workspace switcher,
 * the account menu and every row-action menu in later slices are one control.
 *
 * Content is NOT portalled: it renders inside the `data-harbor` root, so it
 * inherits the tenant's accent like everything else on the screen.
 */

import * as M from "@radix-ui/react-dropdown-menu";
import { clsx } from "clsx";
import type { ComponentProps, ReactNode } from "react";
import { Check } from "./icons";

export const MenuRoot = M.Root;
export const MenuTrigger = M.Trigger;
export const MenuGroup = M.Group;
export const MenuRadioGroup = M.RadioGroup;

export function MenuContent({ className, children, ...rest }: ComponentProps<typeof M.Content>) {
  return (
    <M.Content
      sideOffset={6}
      collisionPadding={8}
      className={clsx(
        "z-50 min-w-[220px] max-w-[360px] rounded-[12px] border border-rule bg-paper p-1.5 text-ui text-fg shadow-float",
        "data-[side=bottom]:[animation:hb-rise_120ms_ease-out] data-[side=top]:[animation:hb-fade_120ms_ease-out]",
        className,
      )}
      {...rest}
    >
      {children}
    </M.Content>
  );
}

const itemClass =
  "relative flex cursor-pointer select-none items-center gap-2 rounded-lg px-2.5 py-2 outline-none " +
  "data-[highlighted]:bg-paper-3 data-[disabled]:cursor-not-allowed data-[disabled]:text-fg-3";

export function MenuItem({
  className,
  children,
  hint,
  tone,
  ...rest
}: ComponentProps<typeof M.Item> & { hint?: ReactNode; tone?: "danger" }) {
  return (
    <M.Item className={clsx(itemClass, tone === "danger" && "text-fail", className)} {...rest}>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint ? <span className="shrink-0 text-meta text-fg-3">{hint}</span> : null}
    </M.Item>
  );
}

export function MenuRadioItem({ className, children, ...rest }: ComponentProps<typeof M.RadioItem>) {
  return (
    <M.RadioItem className={clsx(itemClass, "pl-7", className)} {...rest}>
      <M.ItemIndicator className="absolute left-2 grid size-4 place-items-center text-act">
        <Check size={14} />
      </M.ItemIndicator>
      {children}
    </M.RadioItem>
  );
}

export function MenuLabel({ className, ...rest }: ComponentProps<typeof M.Label>) {
  return <M.Label className={clsx("legend px-2 pb-1 pt-1.5", className)} {...rest} />;
}

export function MenuSeparator() {
  return <M.Separator className="my-1 h-px bg-rule" />;
}
