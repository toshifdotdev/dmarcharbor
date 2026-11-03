import type { Metadata } from "next";
import { getWorkspaceEntitlements, getWorkspaceSecurity, listPendingInvitations } from "@/lib/api-ops";
import { instantLabel } from "@/lib/instant";
import { settingsContext } from "@/lib/settings-context";
import { mayChange } from "@/lib/settings-map";
import { SettingsFrame } from "@/components/harbor/settings/frame";
import { MembersBoard, type InvitationView, type MemberView, type Seats } from "@/components/harbor/settings/members";
import { ErrorState } from "@/components/ui/states";

export const metadata: Metadata = { title: "Members and roles" };

/**
 * /settings/members — the roster, the invitations, and the role table.
 *
 * The plan's team-member limit is counted the way the API counts it before it
 * refuses an invitation: members of this workspace plus invitations still
 * open. At the limit the invite form gives way to the limit itself, and the
 * open invitations stay listed so one can be withdrawn to free a place.
 */
export default async function MembersPage() {
  const ctx = await settingsContext();
  const now = Date.now();
  const [pending, security, entitlements] = await Promise.all([
    listPendingInvitations(ctx.active.id)
      .then((list) => (list ?? []).filter((i) => !i.status || i.status === "pending"))
      .catch(() => null),
    ctx.role === "owner" ? getWorkspaceSecurity(ctx.active.id).catch(() => null) : Promise.resolve(null),
    getWorkspaceEntitlements(ctx.active.id).catch(() => null),
  ]);
  const invitations: InvitationView[] | null = pending
    ? pending.map((i) => ({ id: i.id, email: i.email, role: i.role, expiresLabel: i.expiresAt ? instantLabel(i.expiresAt) : null }))
    : null;

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

  // Only when both counts and the plan were read: a guessed count must not
  // hide the invite form, nor claim room that is not there.
  // A lapsed invitation is still listed (to withdraw) but no longer holds a place.
  const seats: Seats | null =
    members && pending && entitlements
      ? {
          members: members.length,
          pending: pending.filter((i) => !i.expiresAt || new Date(i.expiresAt).getTime() > now).length,
          limit: entitlements.maxMembers,
          plan: entitlements.label,
        }
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
          seats={seats}
        />
      ) : (
        <ErrorState what="the member list" detail="This is not the same as having no members: the list could not be read." />
      )}
    </SettingsFrame>
  );
}
