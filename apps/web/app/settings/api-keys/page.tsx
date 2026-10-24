import type { Metadata } from "next";
import { getWorkspaceEntitlements, listApiKeys, OpsError } from "@/lib/api-ops";
import { featureOf } from "@/lib/entitlements";
import { instantLabel } from "@/lib/instant";
import { settingsContext } from "@/lib/settings-context";
import type { ApiKeyRow } from "@/lib/types";
import { PlanUnknown } from "@/components/harbor/plan-refusal";
import { ApiKeysBoard, type KeyView } from "@/components/harbor/settings/api-keys";
import { SettingsFrame } from "@/components/harbor/settings/frame";
import { ErrorState, PermissionState } from "@/components/ui/states";

export const metadata: Metadata = { title: "API keys" };

const DAY = 24 * 60 * 60 * 1000;

function view(k: ApiKeyRow, now: number): KeyView {
  const expires = k.expiresAt ? new Date(k.expiresAt).getTime() : null;
  const state: KeyView["state"] = k.revokedAt ? "revoked" : expires !== null && expires <= now ? "expired" : "live";
  return {
    id: k.id,
    name: k.name,
    prefix: k.prefix,
    scopes: k.scopes,
    state,
    createdLabel: k.createdAt ? instantLabel(k.createdAt) : null,
    lastUsedLabel: k.lastUsedAt ? instantLabel(k.lastUsedAt) : null,
    lastUsedIp: k.lastUsedIp,
    expiresLabel: k.expiresAt ? instantLabel(k.expiresAt) : null,
    daysLeft: state === "live" && expires !== null ? Math.floor((expires - now) / DAY) : null,
    endedLabel: k.revokedAt ? instantLabel(k.revokedAt) : null,
  };
}

/**
 * /settings/api-keys — owners and admins list and revoke (organization:update);
 * issuing and erasing a revoked record are the owner's (billing:update),
 * because a key acts for the whole workspace. Anyone else is told why, not
 * refused by a 403 they can only guess at.
 */
export default async function ApiKeysPage() {
  const ctx = await settingsContext();
  // Owners and admins read and revoke; only the owner issues.
  const mayRead = ctx.role === null || ctx.role === "owner" || ctx.role === "admin";
  const [listed, entitlements] = mayRead
    ? await Promise.all([
        listApiKeys(ctx.active.id).catch((e: unknown) => (e instanceof OpsError && e.status === 403 ? ("forbidden" as const) : null)),
        getWorkspaceEntitlements(ctx.active.id).catch(() => null),
      ])
    : (["forbidden" as const, null] as const);

  const now = Date.now();
  return (
    <SettingsFrame
      ctx={ctx}
      section="api-keys"
      lede="Keys for the public API. Each acts for this whole workspace until it is revoked or expires, so the decision here is mostly which to revoke."
    >
      {listed === "forbidden" ? (
        <PermissionState
          what="API keys"
          detail="Owners and admins see and revoke keys; only the owner issues them, because a key acts with the whole workspace's access. Ask the owner to issue one for your integration."
          back={{ label: "All settings", href: "/settings" }}
        />
      ) : listed === null ? (
        <ErrorState what="the API key list" detail="No key was changed. Retry to read the list." />
      ) : (
        <>
          {entitlements === null ? <PlanUnknown what="issuing API keys" /> : null}
          <ApiKeysBoard
            organizationId={ctx.active.id}
            keys={listed.apiKeys.map((k) => view(k, now))}
            issuing={featureOf(entitlements, "api.access")}
            canIssue={ctx.role === null || ctx.role === "owner"}
          />
        </>
      )}
    </SettingsFrame>
  );
}
