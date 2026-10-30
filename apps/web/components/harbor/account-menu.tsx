"use client";

/**
 * account-menu.tsx — who is signed in, and the ways out.
 *
 * The trigger shows initials; the menu names the person and the address in
 * full, because "which of our three logins is this" is a real question on a
 * shared MSP desk. Sign out ends this session; "Sessions" is where every other
 * signed-in device is seen and ended.
 */

import { useRouter } from "next/navigation";
import { useState } from "react";
import { signOut } from "@/lib/auth-client";
import { MenuContent, MenuItem, MenuLabel, MenuRoot, MenuSeparator, MenuTrigger } from "@/components/ui/menu";

function initials(name: string | null, email: string | null) {
  const source = name || email || "?";
  const parts = source.replace(/@.*/, "").split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
}

export function AccountMenu({ name, email }: { name: string | null; email: string | null }) {
  const router = useRouter();
  const [leaving, setLeaving] = useState(false);

  async function leave() {
    setLeaving(true);
    await signOut();
    router.replace("/sign-in");
    router.refresh();
  }

  return (
    <MenuRoot modal={false}>
      <MenuTrigger
        aria-label={`Account: ${email ?? "signed in"}`}
        className="grid size-9 shrink-0 place-items-center rounded-full border border-rule-2 bg-paper text-[11.5px] font-bold text-fg-2 hover:border-fg-3 hover:text-fg data-[state=open]:border-fg-3"
      >
        {initials(name, email)}
      </MenuTrigger>
      <MenuContent align="end" className="w-[280px]">
        <div className="px-2 pb-2 pt-1.5">
          <MenuLabel className="px-0 pt-0">Signed in as</MenuLabel>
          {name ? <p className="truncate text-ui font-semibold text-fg">{name}</p> : null}
          <p className="data truncate text-meta text-fg-2">{email ?? "this account"}</p>
        </div>
        <MenuSeparator />
        <MenuItem onSelect={() => router.push("/notifications")}>Notifications and preferences</MenuItem>
        <MenuItem onSelect={() => router.push("/settings/sessions")}>Signed-in sessions</MenuItem>
        <MenuSeparator />
        <MenuItem
          onSelect={(e) => {
            e.preventDefault();
            void leave();
          }}
          disabled={leaving}
        >
          {leaving ? "Signing out…" : "Sign out"}
        </MenuItem>
      </MenuContent>
    </MenuRoot>
  );
}
