import type { Metadata } from "next";
import { listSsoConnections, OpsError } from "@/lib/api-ops";
import { instantLabel } from "@/lib/instant";
import { settingsContext } from "@/lib/settings-context";
import { mayChange } from "@/lib/settings-map";
import type { SsoConnectionRow } from "@/lib/types";
import { SettingsFrame } from "@/components/harbor/settings/frame";
import { SsoBoard } from "@/components/harbor/settings/sso";
import { ErrorState, PermissionState, UpgradeNotice } from "@/components/ui/states";

export const metadata: Metadata = { title: "Single sign-on" };

type Read =
  | { kind: "ok"; connections: SsoConnectionRow[] }
  | { kind: "plan"; message: string | null; feature: string }
  | { kind: "forbidden" }
  | { kind: "failed" };

/**
 * /settings/sso — the plan gate (auth.sso) is on the read itself, so a 402 here
 * is the answer "not on this plan", said with the API's own sentence and the
 * key on a data attribute.
 */
export default async function SsoPage() {
  const ctx = await settingsContext();
  const read: Read = await listSsoConnections(ctx.active.id)
    .then((r): Read => ({ kind: "ok", connections: r.connections }))
    .catch((e: unknown): Read => {
      if (e instanceof OpsError && e.status === 402) return { kind: "plan", message: e.body?.message ?? null, feature: e.feature ?? "auth.sso" };
      if (e instanceof OpsError && e.status === 403) return { kind: "forbidden" };
      return { kind: "failed" };
    });

  return (
    <SettingsFrame
      ctx={ctx}
      section="sso"
      lede="Sign in through your identity provider instead of passwords. The decision is who it lets in: the email domains on its allowlist, and the role they arrive with."
    >
      {read.kind === "ok" && read.connections.some((c) => c.paused) ? (
        <>
          <UpgradeNotice
            message="Single sign-on is not included in this workspace's plan."
            feature="auth.sso"
            context={
              read.connections[0]?.signInUntil
                ? `Nobody new can join through these connections. Existing members can keep signing in through them until ${instantLabel(read.connections[0].signInUntil)}; after that they sign in with a password, and Forgot password creates one for anyone who never set it.`
                : "Nobody new can join through these connections. Existing members sign in with a password; Forgot password creates one for anyone who never set it."
            }
          />
          <SsoBoard
            organizationId={ctx.active.id}
            connections={read.connections}
            canManage={ctx.role === null ? true : mayChange(ctx.role, "admin")}
            paused
          />
        </>
      ) : read.kind === "ok" ? (
        <SsoBoard
          organizationId={ctx.active.id}
          connections={read.connections}
          canManage={ctx.role === null ? true : mayChange(ctx.role, "admin")}
        />
      ) : read.kind === "plan" ? (
        <UpgradeNotice
          message={read.message ?? "Single sign-on is not included in this workspace's plan."}
          feature={read.feature}
          context="Everyone keeps signing in with a password or a social account."
        />
      ) : read.kind === "forbidden" ? (
        <PermissionState
          what="single sign-on"
          detail="Connections are set up by an owner or admin, because each one decides who can join this workspace."
          back={{ label: "All settings", href: "/settings" }}
        />
      ) : (
        <ErrorState what="the SSO connections" detail="No connection was changed. Retry to read them." />
      )}
    </SettingsFrame>
  );
}
