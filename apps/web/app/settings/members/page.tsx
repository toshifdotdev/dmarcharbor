import type { Metadata } from "next";
import { getWorkspaceSecurity, listPendingInvitations } from "@/lib/api-ops";
import { instantLabel } from "@/lib/instant";
import { settingsContext } from "@/lib/settings-context";
import { mayChange } from "@/lib/settings-map";
import { SettingsFrame } from "@/components/harbor/settings/frame";
import { MembersBoard, type InvitationView, type MemberView } from "@/components/harbor/settings/members";
import { ErrorState } from "@/components/ui/states";

export const metadata: Metadata = { title: "Members and roles" };

/** /settings/members — the roster, the invitations, and the role table. */
export default async function MembersPage() {
  const ctx = await settingsContext();
  const [invitations, security] = await Promise.all([
    listPendingInvitations(ctx.active.id)
      .then((list): InvitationView[] =>
        (list ?? [])
          .filter((i) => !i.status || i.status === "pending")
          .map((i) => ({ id: i.id, email: i.email, role: i.role, expiresLabel: i.expiresAt ? instantLabel(i.expiresAt) : null })),
      )
      .catch(() => null),
    ctx.role === "owner" ? getWorkspaceSecurity(ctx.active.id).catch(() => null) : Promise.resolve(null),
  ]);

  const members: MemberView[] | null = ctx.members
    ? [...ctx.members]
        .map((m) => ({
          id: m.id,
          userId: m.userId,
          role: m.role,
          name: m.user?.name || m.user?.email || "A member",
          email: m.user?.email ?? null,
          ...(m.twoFactorEnabled === undefined ? {} : { twoFactorEnabled: m.twoFactorEnabled }),
        }))
        .sort((a, b) => {
          const rank = (r: string) => ["owner", "admin", "analyst", "viewer", "portal"].indexOf(r.split(",")[0]);
          return rank(a.role) - rank(b.role) || a.name.localeCompare(b.name);
        })
    : null;

  return (
    <SettingsFrame ctx={ctx} section="members">
      {members ? (
        <MembersBoard
          organizationId={ctx.active.id}
          members={members}
          invitations={invitations}
          security={security}
          canManage={ctx.role === null ? true : mayChange(ctx.role, "admin")}
          isOwner={ctx.role === "owner"}
          selfUserId={ctx.userId}
        />
      ) : (
        <ErrorState what="the member list" detail="This is not the same as having no members: the list could not be read." />
      )}
    </SettingsFrame>
  );
}
