"use client";

/**
 * members.tsx — who works in this workspace, and what their role lets them do.
 *
 * The cost of a wrong role is concrete: an admin can invite and remove people
 * and change every integration; an analyst can read named-recipient-free
 * forensic samples; a viewer only reads. So a role change is confirmed with
 * exactly what the person gains and loses, read from the same table the page
 * shows (which is apps/api/src/auth/permissions.ts written down), and the
 * table itself is on the page so nobody has to guess what "analyst" means.
 *
 * Owners are not edited or removed here: ownership is the account that can
 * delete the workspace and change the plan, and a workspace has one owner.
 * It moves only through Transfer ownership, where the owner picks a member and
 * confirms with their password or an authenticator code, and becomes an admin.
 *
 * Invitations are emailed by the API (sendInvitationEmail) with a link to
 * /welcome, where the invited address finds them; the portfolio lists them too.
 * A pending one can be sent again (the plugin's own resend: same invitation,
 * new expiry, new email) or withdrawn. An expired one is listed apart, as
 * Expired, outside the waiting count, with the same two actions.
 *
 * The page reads in the order the job comes: who is here, invite someone, the
 * workspace's two-step rule, then what each role can do. That last table is
 * drawn as a line diagram: each role is a line running down the capabilities
 * it stops at, ending at a terminus. The roles nest, so the lines read like a
 * timetable: the owner's runs the whole way, a portal contact's stops after
 * the first.
 */

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import {
  cancelInvitation,
  inviteMember,
  removeMember,
  resendInvitation,
  resetMemberMfa,
  previewOwnershipTransfer,
  setWorkspaceMfaRequirement,
  transferOwnership,
  updateMemberRole,
} from "@/lib/ops-client";
import type { OwnershipTransferPreview, PlanDefinition, WorkspaceSecurity } from "@/lib/types";
import { transferPlanSummary } from "@/lib/ownership-transfer";
import { limitReached } from "@/lib/entitlements";
import { ActionRefusal, PlanLimitNotice, UsageLine, type ActionError } from "@/components/harbor/plan-refusal";
import { Button } from "@/components/ui/button";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { Field, Input, Segmented, Select } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { Table, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { Panel, StateMark, StateWord, plural } from "./parts";

const ROLES = ["owner", "admin", "analyst", "viewer", "portal"] as const;
type Role = (typeof ROLES)[number];
const ASSIGNABLE = ["admin", "analyst", "viewer"] as const;
type Assignable = (typeof ASSIGNABLE)[number];

const ROLE_SUMMARY: Record<Role, string> = {
  owner: "Everything, including the plan, API keys, erasure and deleting the workspace.",
  admin: "Runs the workspace: people, clients, integrations, branding. Not billing or deletion.",
  analyst: "Works the evidence: edits domains and reports, reads forensic samples without names.",
  viewer: "Reads clients, domains and reports. Changes nothing.",
  portal: "Reads reports only. Meant for client contacts, who are better added under Client portal access.",
};

/** What each role may do, from apps/api/src/auth/permissions.ts. */
const CAPABILITIES: Array<{ label: string; roles: Role[] }> = [
  { label: "Read clients, domains and reports", roles: ["owner", "admin", "analyst", "viewer", "portal"] },
  { label: "See the plan and its usage", roles: ["owner", "admin", "analyst", "viewer"] },
  { label: "Edit domains and reports", roles: ["owner", "admin", "analyst"] },
  { label: "Read forensic samples, recipients hidden", roles: ["owner", "admin", "analyst"] },
  { label: "See forensic recipients by name, purge samples", roles: ["owner", "admin"] },
  { label: "Add, change and remove clients", roles: ["owner", "admin"] },
  { label: "Invite, re-role and remove people", roles: ["owner", "admin"] },
  { label: "Change integrations, branding and SSO", roles: ["owner", "admin"] },
  { label: "See and revoke API keys", roles: ["owner", "admin"] },
  { label: "Change the plan, issue API keys, erase data", roles: ["owner"] },
  { label: "Delete the workspace, or hand it to another member", roles: ["owner"] },
];

function diff(from: Role, to: Role) {
  const gains = CAPABILITIES.filter((c) => c.roles.includes(to) && !c.roles.includes(from)).map((c) => c.label);
  const losses = CAPABILITIES.filter((c) => c.roles.includes(from) && !c.roles.includes(to)).map((c) => c.label);
  return { gains, losses };
}

const asRole = (r: string): Role => ((ROLES as readonly string[]).includes(r) ? (r as Role) : "viewer");
const isAssignable = (r: string): r is Assignable => (ASSIGNABLE as readonly string[]).includes(r);

export interface MemberView {
  id: string;
  userId: string;
  role: string;
  name: string;
  email: string | null;
  /** Absent for readers who are neither owner nor admin. */
  twoFactorEnabled?: boolean;
}

export interface InvitationView {
  id: string;
  email: string;
  role: string;
  expiresLabel: string | null;
  /** Past its expiry: it can no longer be accepted and holds no place. */
  expired?: boolean;
}

/**
 * The plan's team-member limit, counted as the API counts it before it
 * refuses an invitation: members of this workspace plus invitations still
 * open. `limit` null is no limit.
 */
export interface Seats {
  members: number;
  pending: number;
  limit: number | null;
  plan: string;
}

export function MembersBoard({
  organizationId,
  members,
  invitations,
  security,
  canManage,
  isOwner,
  selfUserId,
  seats = null,
  plans = null,
}: {
  organizationId: string;
  members: MemberView[];
  /** null when the pending list could not be read. */
  invitations: InvitationView[] | null;
  /** null when the workspace requirement could not be read. */
  security: WorkspaceSecurity | null;
  canManage: boolean;
  isOwner: boolean;
  selfUserId: string | null;
  /** null when the plan or a count could not be read: the form is offered and the API decides. */
  seats?: Seats | null;
  /** The plan catalog, read for the owner: the transfer confirmation lists what a lower plan stops. */
  plans?: PlanDefinition[] | null;
}) {
  const waiting = invitations ? invitations.filter((inv) => !inv.expired) : null;
  const expired = invitations ? invitations.filter((inv) => inv.expired) : [];
  const seatsUsed = seats ? seats.members + seats.pending : 0;
  const seatsFull = seats !== null && limitReached({ used: seatsUsed, limit: seats.limit });
  const router = useRouter();
  const toast = useToast();

  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<Assignable>("analyst");
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteError, setInviteError] = useState<ActionError | null>(null);
  const [invited, setInvited] = useState<string | null>(null);

  const [change, setChange] = useState<{ m: MemberView; to: Role } | null>(null);
  const [removing, setRemoving] = useState<MemberView | null>(null);
  const [cancelling, setCancelling] = useState<InvitationView | null>(null);
  const [resending, setResending] = useState<string | null>(null);
  const [resetting, setResetting] = useState<MemberView | null>(null);
  const [resetBusy, setResetBusy] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [successorId, setSuccessorId] = useState("");
  const [transferOpen, setTransferOpen] = useState(false);
  const [transferWith, setTransferWith] = useState<"password" | "code">("password");
  const [transferProof, setTransferProof] = useState("");
  const [transferBusy, setTransferBusy] = useState(false);
  const [transferError, setTransferError] = useState<string | null>(null);
  // What the transfer would do, read when the dialog opens: null while reading.
  const [preview, setPreview] = useState<OwnershipTransferPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const [mfaSecurity, setMfaSecurity] = useState(security);
  const [mfaBusy, setMfaBusy] = useState(false);
  const [mfaError, setMfaError] = useState<string | null>(null);
  const [mfaCallerError, setMfaCallerError] = useState<string | null>(null);

  const showTwoStep = canManage && members.some((member) => member.twoFactorEnabled !== undefined);

  async function invite(e: FormEvent) {
    e.preventDefault();
    const address = email.trim().toLowerCase();
    if (!address || inviteBusy) return;
    setInviteBusy(true);
    setInviteError(null);
    setInvited(null);
    const res = await inviteMember(organizationId, address, inviteRole);
    setInviteBusy(false);
    if (!res.ok) {
      setInviteError(res.error);
      return;
    }
    setInvited(address);
    setEmail("");
    router.refresh();
  }

  async function run(action: () => Promise<{ ok: boolean; error?: { message?: string } }>, done: string, close: () => void) {
    setBusy(true);
    setError(null);
    const res = await action();
    setBusy(false);
    if (!res.ok) {
      setError(res.error?.message ?? "That did not go through. Nothing changed.");
      return;
    }
    toast({ title: done, tone: "ok" });
    close();
    router.refresh();
  }

  const changeDiff = change ? diff(asRole(change.m.role), change.to) : null;

  /**
   * The same invitation again, with a fresh expiry and a fresh email. Not
   * confirmed: it only repeats what was already sent to the same address.
   */
  async function resend(inv: InvitationView) {
    if (resending !== null || !isAssignable(inv.role)) return;
    setResending(inv.id);
    const res = await resendInvitation(organizationId, inv.email, inv.role);
    setResending(null);
    if (!res.ok) {
      toast({ title: res.error?.message ?? "The invitation could not be sent again.", tone: "fail" });
      return;
    }
    toast({ title: `Invitation sent to ${inv.email} again`, body: "It has a new expiry, shown in the list.", tone: "ok" });
    router.refresh();
  }

  async function resetTwoStep() {
    if (!resetting) return;
    setResetBusy(true);
    setResetError(null);
    const res = await resetMemberMfa(organizationId, resetting.id);
    setResetBusy(false);
    if (!res.ok) {
      setResetError(res.error?.message ?? "That did not go through. Nothing changed.");
      return;
    }
    toast({ title: `${resetting.name}'s two-step verification is reset`, tone: "ok" });
    setResetting(null);
    router.refresh();
  }

  async function toggleWorkspaceMfa() {
    if (!mfaSecurity || mfaBusy) return;
    setMfaBusy(true);
    setMfaError(null);
    setMfaCallerError(null);
    const res = await setWorkspaceMfaRequirement(organizationId, !mfaSecurity.requireMfa);
    setMfaBusy(false);
    if (!res.ok) {
      if (res.error?.code === "MFA_REQUIRED_FOR_CALLER") {
        setMfaCallerError(
          res.error.message ??
            "Turn on two-step verification for your own account first, so you do not lock yourself out.",
        );
      } else {
        setMfaError(res.error?.message ?? "That did not go through. Nothing changed.");
      }
      return;
    }
    setMfaSecurity({
      requireMfa: res.data.requireMfa,
      changedAt: new Date().toISOString(),
      membersWithout: res.data.membersWithout,
    });
    toast({
      title: res.data.requireMfa
        ? "Two-step verification is required for this workspace"
        : "Two-step verification is no longer required",
      tone: "ok",
    });
    router.refresh();
  }

  // Anyone on the team but the owner and client portal contacts.
  const successors = members.filter((m) => m.userId !== selfUserId && asRole(m.role) !== "owner" && asRole(m.role) !== "portal");
  const successor = successors.find((m) => m.id === successorId) ?? null;

  async function openTransfer() {
    if (!successor) return;
    setTransferError(null);
    setTransferProof("");
    setPreview(null);
    setPreviewError(null);
    setTransferOpen(true);
    const res = await previewOwnershipTransfer(organizationId, successor.id);
    if (!res.ok) {
      setPreviewError(res.error?.message ?? "What the transfer would change could not be read. Close this and try again.");
      return;
    }
    setPreview(res.data);
  }

  const summary = preview ? transferPlanSummary(preview, plans) : null;
  const refusal = preview?.refusal ?? null;
  const transferReady = preview !== null && refusal === null;

  async function transfer() {
    if (!successor || transferBusy || !transferReady) return;
    const proof = transferProof.trim();
    if (!proof) {
      setTransferError(transferWith === "password" ? "Enter your password." : "Enter the code from your authenticator app.");
      return;
    }
    setTransferBusy(true);
    setTransferError(null);
    const res = await transferOwnership(
      organizationId,
      successor.id,
      transferWith === "password" ? { password: transferProof } : { code: proof },
    );
    setTransferBusy(false);
    if (!res.ok) {
      setTransferError(res.error?.message ?? "That did not go through. Nothing changed.");
      return;
    }
    setTransferOpen(false);
    setTransferProof("");
    setSuccessorId("");
    toast({
      title: `${successor.name} now owns this workspace`,
      body: `You are an admin. The workspace follows their plan, ${res.data.planLabel}.`,
      tone: "ok",
    });
    router.refresh();
  }

  const withTwoStep = members.filter((m) => m.twoFactorEnabled).length;
  const roleCount = (r: Role) => members.filter((m) => asRole(m.role) === r).length;

  return (
    <div className="flex flex-col gap-14">
      <Panel
        id="people"
        title="People"
        aside={
          <>
            <span className="tnum font-semibold text-fg-2">{plural(members.length, "member")}</span>
            {showTwoStep ? <span className="tnum">{withTwoStep} with two-step verification on</span> : null}
          </>
        }
      >
        <Table caption="Workspace members" minWidth={640}>
          <THead>
            <tr>
              <Th>Person</Th>
              <Th>Role</Th>
              {showTwoStep ? <Th>Two-step</Th> : null}
              <Th align="right">
                <span className="sr-only">Action</span>
              </Th>
            </tr>
          </THead>
          <TBody>
            {members.map((m) => {
              const self = m.userId === selfUserId;
              const role = asRole(m.role);
              const editable = canManage && role !== "owner" && !self;
              return (
                <Tr key={m.id}>
                  <Td className="py-2.5">
                    <span className="flex flex-wrap items-baseline gap-x-2">
                      <span className="text-body font-semibold">{m.name}</span>
                      {self ? <span className="text-meta font-semibold text-fg-3">you</span> : null}
                    </span>
                    {m.email ? <span className="data block break-all text-meta text-fg-3">{m.email}</span> : null}
                  </Td>
                  <Td className="py-2.5">
                    {editable ? (
                      <Select
                        size="sm"
                        aria-label={`Role for ${m.name}`}
                        value={role}
                        onChange={(e) => {
                          setError(null);
                          setChange({ m, to: asRole(e.target.value) });
                        }}
                        data-testid={`member-role-${m.id}`}
                      >
                        {ASSIGNABLE.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                        {role === "portal" ? <option value="portal">portal</option> : null}
                      </Select>
                    ) : (
                      <span className="font-semibold capitalize">{role}</span>
                    )}
                    <span className="mt-1 block max-w-[46ch] text-meta text-fg-3">{ROLE_SUMMARY[role]}</span>
                  </Td>
                  {showTwoStep ? (
                    <Td className="whitespace-nowrap py-2.5">
                      {m.twoFactorEnabled === undefined ? (
                        <span className="text-meta text-fg-3">Not reported</span>
                      ) : m.twoFactorEnabled ? (
                        <StateWord shape="square" tone="ok">
                          On
                        </StateWord>
                      ) : (
                        <StateWord shape="closed" tone="void">
                          Off
                        </StateWord>
                      )}
                    </Td>
                  ) : null}
                  <Td align="right" className="whitespace-nowrap py-2.5">
                    <div className="flex flex-wrap items-center justify-end gap-1">
                      {isOwner && !self && m.twoFactorEnabled ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setResetError(null);
                            setResetting(m);
                          }}
                        >
                          Reset two-step verification
                        </Button>
                      ) : null}
                      {editable ? (
                        <Button
                          size="sm"
                          variant="danger-quiet"
                          onClick={() => {
                            setError(null);
                            setRemoving(m);
                          }}
                        >
                          Remove
                        </Button>
                      ) : null}
                    </div>
                  </Td>
                </Tr>
              );
            })}
          </TBody>
        </Table>
        {canManage ? (
          <p className="text-meta text-fg-3">Owners are not re-roled or removed here, and nobody changes their own role.</p>
        ) : null}
      </Panel>

      <Panel
        id="invite"
        title="Invite someone"
        why="Invite colleagues. Client contacts go under Client portal access, which limits them to their own client."
        aside={
          seats || (waiting && waiting.length > 0) ? (
            <>
              {seats ? (
                <UsageLine
                  quota="member"
                  used={seatsUsed}
                  limit={seats.limit}
                  noun="team members"
                  suffix=", open invitations included"
                />
              ) : null}
              {waiting && waiting.length > 0 ? (
                <span className="tnum" data-testid="waiting-count">
                  {plural(waiting.length, "invitation")} waiting
                </span>
              ) : null}
            </>
          ) : null
        }
      >
        {canManage && seatsFull && seats ? (
          <div className="flex flex-col gap-3">
            <PlanLimitNotice
              quota="member"
              message={`${seats.plan} includes ${seats.limit} team member${seats.limit === 1 ? "" : "s"}, and this workspace has ${plural(seats.members, "member")}${
                seats.pending > 0 ? ` and ${plural(seats.pending, "open invitation")}` : ""
              }.`}
              context={
                seats.pending > 0
                  ? "Withdraw an invitation below, or remove someone above, to free a place. Or move to a plan with a larger team."
                  : "Remove someone above to free a place, or move to a plan with a larger team."
              }
            />
            <ActionRefusal error={inviteError} />
          </div>
        ) : canManage ? (
          <form onSubmit={invite} className="flex flex-col gap-3">
            <div className="flex flex-wrap items-start gap-x-3 gap-y-3">
              <Field label="Email address" className="min-w-[min(100%,300px)] flex-1 basis-[300px]">
                <Input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="alex@youragency.example"
                  autoComplete="off"
                  data-testid="invite-email"
                />
              </Field>
              <Field label="Role" hint={ROLE_SUMMARY[inviteRole]} className="w-full sm:w-[min(100%,280px)]">
                <Select
                  value={inviteRole}
                  onChange={(e) => setInviteRole(e.target.value as Assignable)}
                  data-testid="invite-role"
                  className="w-full"
                >
                  {ASSIGNABLE.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </Select>
              </Field>
              <div className="sm:pt-[22px]">
                <Button type="submit" variant="primary" busy={inviteBusy} busyLabel="Recording the invitation">
                  Invite
                </Button>
              </div>
            </div>
            <p className="max-w-[72ch] text-meta text-fg-3">
              They get an email with a link. They sign in, or create an account, with exactly this address and find the
              invitation waiting: on the first screen, or above the portfolio if they already have a workspace. Signing
              in through this workspace&rsquo;s single sign-on accepts it on the way in.
            </p>
            <ActionRefusal error={inviteError} />
            {invited ? (
              <Notice tone="ok" title={`Invitation sent to ${invited}`}>
                It stays pending until they accept it.
              </Notice>
            ) : null}
          </form>
        ) : (
          <p className="text-ui text-fg-2">An owner or admin of this workspace can invite people.</p>
        )}

        <div className="mt-3">
          <h3 className="text-ui font-bold text-fg">Waiting to be accepted</h3>
          {waiting === null ? (
            <Notice tone="warn" title="The pending invitations could not be read" className="mt-2">
              This is not the same as having none. Reload to try again.
            </Notice>
          ) : waiting.length === 0 ? (
            <p className="mt-1 text-ui text-fg-3">No invitation is waiting.</p>
          ) : (
            <ul data-testid="pending-invitations" className="mt-2 flex flex-col border-t border-rule">
              {waiting.map((inv) => (
                <li
                  key={inv.id}
                  className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-0.5 border-b border-rule py-2.5 text-ui sm:grid-cols-[auto_minmax(0,1fr)_7rem_minmax(0,12rem)_auto]"
                >
                  <span className="relative top-[1px]">
                    <StateMark shape="ring" tone="warn" />
                  </span>
                  <span className="data min-w-0 break-all font-semibold text-fg">{inv.email}</span>
                  <span className="hidden capitalize text-fg-2 sm:block">{inv.role}</span>
                  <span className="col-start-2 text-meta text-fg-3 sm:col-start-auto">
                    <span className="capitalize sm:hidden">{inv.role} · </span>
                    {inv.expiresLabel ? `Lapses ${inv.expiresLabel}` : "No end date recorded"}
                  </span>
                  {canManage ? (
                    <span className="col-start-3 row-start-1 flex items-center gap-1 self-center sm:col-start-auto sm:row-start-auto">
                      {isAssignable(inv.role) ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={resending !== null && resending !== inv.id}
                          busy={resending === inv.id}
                          busyLabel="Sending"
                          data-testid={`resend-invitation-${inv.id}`}
                          aria-label={`Send the invitation to ${inv.email} again`}
                          onClick={() => void resend(inv)}
                        >
                          Resend
                        </Button>
                      ) : null}
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setError(null);
                          setCancelling(inv);
                        }}
                      >
                        Withdraw
                      </Button>
                    </span>
                  ) : (
                    <span />
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        {expired.length > 0 ? (
          <div className="mt-3">
            <h3 className="text-ui font-bold text-fg">Expired</h3>
            <p className="mt-0.5 max-w-[72ch] text-meta text-fg-3">
              These can no longer be accepted and hold no place on the team. Resend one to send a fresh invitation.
            </p>
            <ul data-testid="expired-invitations" className="mt-2 flex flex-col border-t border-rule">
              {expired.map((inv) => (
                <li
                  key={inv.id}
                  data-testid={`expired-invitation-${inv.id}`}
                  className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-0.5 border-b border-rule py-2.5 text-ui sm:grid-cols-[auto_minmax(0,1fr)_7rem_minmax(0,12rem)_auto]"
                >
                  <span className="relative top-[1px]">
                    <StateMark shape="closed" tone="void" />
                  </span>
                  <span className="data min-w-0 break-all font-semibold text-fg-2">{inv.email}</span>
                  <span className="hidden capitalize text-fg-3 sm:block">{inv.role}</span>
                  <span className="col-start-2 text-meta text-fg-3 sm:col-start-auto">
                    <span className="capitalize sm:hidden">{inv.role} · </span>
                    <span className="font-semibold">Expired</span>
                    {inv.expiresLabel ? ` ${inv.expiresLabel}` : null}
                  </span>
                  {canManage ? (
                    <span className="col-start-3 row-start-1 flex items-center gap-1 self-center sm:col-start-auto sm:row-start-auto">
                      {isAssignable(inv.role) ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={resending !== null && resending !== inv.id}
                          busy={resending === inv.id}
                          busyLabel="Sending"
                          data-testid={`resend-invitation-${inv.id}`}
                          aria-label={`Send a new invitation to ${inv.email}`}
                          onClick={() => void resend(inv)}
                        >
                          Resend
                        </Button>
                      ) : null}
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setError(null);
                          setCancelling(inv);
                        }}
                      >
                        Withdraw
                      </Button>
                    </span>
                  ) : (
                    <span />
                  )}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </Panel>

      {isOwner && successors.length > 0 ? (
        <Panel
          id="ownership"
          title="Transfer ownership"
          why="A workspace has one owner: the account that holds the plan, manages billing and can delete the workspace. Hand it to a member and you stay on the team as an admin."
        >
          <div className="flex flex-wrap items-end gap-x-3 gap-y-3">
            <Field label="New owner" className="w-full sm:w-[min(100%,360px)]">
              <Select
                value={successorId}
                onChange={(e) => setSuccessorId(e.target.value)}
                data-testid="transfer-owner-member"
                className="w-full"
              >
                <option value="">Choose a member</option>
                {successors.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                    {m.email && m.email !== m.name ? ` (${m.email})` : ""}
                  </option>
                ))}
              </Select>
            </Field>
            <Button
              variant="secondary"
              disabled={!successorId}
              data-testid="transfer-owner-open"
              onClick={() => void openTransfer()}
            >
              Transfer ownership
            </Button>
          </div>
          <p className="max-w-[72ch] text-meta text-fg-3">
            The workspace then follows the plan on their account and counts toward its workspace, client and domain
            limits. It is refused if their plan has no room. You are both emailed, and it is recorded in the audit trail.
          </p>
        </Panel>
      ) : null}

      {isOwner ? (
        <Panel
          id="two-step"
          title="Require two-step verification"
          why="Refuse workspace access until each member has an authenticator app. It applies to the API, not only to what this screen shows."
          aside={
            mfaSecurity ? (
              mfaSecurity.requireMfa ? (
                <StateWord shape="square" tone="ok">
                  Required
                </StateWord>
              ) : (
                <StateWord shape="closed" tone="void">
                  Not required
                </StateWord>
              )
            ) : null
          }
        >
          {mfaSecurity ? (
            <>
              <p className="text-body text-fg">
                {mfaSecurity.requireMfa
                  ? "Two-step verification is required. "
                  : "Two-step verification is not required. "}
                <span className="tnum font-semibold">
                  {mfaSecurity.membersWithout} non-portal member{mfaSecurity.membersWithout === 1 ? "" : "s"}
                </span>{" "}
                {mfaSecurity.membersWithout === 1 ? "has" : "have"} not set it up.
              </p>
              <p className="max-w-[72ch] text-ui text-fg-2">
                Members who sign in with Google or Microsoft will have to set a password and an authenticator app,
                because we cannot see whether Google or Microsoft asked them for a second step. Single sign-on members
                are not affected: your identity provider handles it. Client portal contacts are not affected.
              </p>
              {mfaCallerError ? (
                <Notice tone="warn" title={mfaCallerError}>
                  <Link href="/account/security" className="link font-semibold">
                    Open account security
                  </Link>{" "}
                  to turn it on for your own account.
                </Notice>
              ) : null}
              {mfaError ? <Notice tone="fail" title={mfaError} /> : null}
              <div>
                <Button
                  variant={mfaSecurity.requireMfa ? "secondary" : "primary"}
                  busy={mfaBusy}
                  busyLabel="Saving"
                  onClick={toggleWorkspaceMfa}
                >
                  {mfaSecurity.requireMfa ? "Stop requiring two-step verification" : "Require two-step verification"}
                </Button>
              </div>
            </>
          ) : (
            <Notice tone="warn" title="The two-step requirement could not be read">
              This is not the same as it being off. Reload the page to try again.
            </Notice>
          )}
        </Panel>
      ) : null}

      <Panel
        id="roles"
        title="What each role can do"
        why="Each role is a line that stops at what it may do. The API checks these on every request, and this page offers only what your role allows."
      >
        <Table caption="Capabilities by role" minWidth={720}>
          <THead>
            <tr>
              <Th>Capability</Th>
              {ROLES.map((r) => {
                const n = roleCount(r);
                return (
                  <Th key={r} align="center" className="w-[92px]">
                    <span className="block text-ui font-bold capitalize text-fg">{r}</span>
                    <span className="tnum block font-medium text-fg-3">{n === 0 ? "nobody" : plural(n, "person", "people")}</span>
                  </Th>
                );
              })}
            </tr>
          </THead>
          <TBody>
            {CAPABILITIES.map((c, row) => (
              <Tr key={c.label}>
                <Td className="py-2.5">{c.label}</Td>
                {ROLES.map((r) => {
                  const has = c.roles.includes(r);
                  const from = row > 0 && CAPABILITIES[row - 1].roles.includes(r);
                  const on = row < CAPABILITIES.length - 1 && CAPABILITIES[row + 1].roles.includes(r);
                  return (
                    <Td key={r} align="center" className="relative py-2.5">
                      {has ? (
                        <>
                          <span
                            aria-hidden
                            className="absolute left-1/2 w-[5px] -translate-x-1/2 bg-fg"
                            style={{ top: from ? -1 : "50%", bottom: on ? -1 : "50%" }}
                          />
                          <span
                            aria-hidden
                            className={
                              on
                                ? "absolute left-1/2 top-1/2 z-[1] block size-[15px] -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] border-fg bg-paper"
                                : "absolute left-1/2 top-1/2 z-[1] block h-[15px] w-[25px] -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] border-fg bg-paper"
                            }
                          />
                          <span className="sr-only">yes</span>
                        </>
                      ) : (
                        <span className="sr-only">no</span>
                      )}
                    </Td>
                  );
                })}
              </Tr>
            ))}
          </TBody>
        </Table>
        <p className="text-meta text-fg-3">
          A role&rsquo;s line ends at the last thing it may do. Portal contacts are client contacts: add them under{" "}
          <Link href="/settings/portal" className="link">
            Client portal access
          </Link>
          , which keeps each one to their own client.
        </p>
      </Panel>

      <ConfirmDialog
        open={resetting !== null}
        onClose={() => {
          setResetting(null);
          setResetError(null);
        }}
        onConfirm={resetTwoStep}
        title={resetting ? `Reset two-step verification for ${resetting.name}?` : "Reset two-step verification?"}
        body={
          resetting ? (
            <>
              <p>
                Their authenticator app and backup codes stop working, and two-step verification is turned off for the
                account. They are signed out everywhere, including any device they are using now.
              </p>
              <p className="mt-2">They can set it up again with their password. Their account and other workspaces are untouched.</p>
            </>
          ) : null
        }
        confirmLabel="Reset two-step verification"
        busy={resetBusy}
        danger
        error={resetting ? resetError : null}
      />

      <ConfirmDialog
        open={change !== null}
        onClose={() => setChange(null)}
        onConfirm={() =>
          change &&
          run(
            () => updateMemberRole(organizationId, change.m.id, change.to),
            `${change.m.name} is now ${/^[aeiou]/.test(change.to) ? "an" : "a"} ${change.to}`,
            () => setChange(null),
          )
        }
        title={change ? `Make ${change.m.name} ${/^[aeiou]/.test(change.to) ? "an" : "a"} ${change.to}?` : "Change role?"}
        body={
          change && changeDiff ? (
            <div className="flex flex-col gap-2">
              {changeDiff.gains.length > 0 ? (
                <div>
                  <p className="text-ui font-semibold text-fg">They will be able to</p>
                  <ul className="mt-0.5 list-disc pl-5 text-ui">
                    {changeDiff.gains.map((g) => (
                      <li key={g}>{g.charAt(0).toLowerCase() + g.slice(1)}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {changeDiff.losses.length > 0 ? (
                <div>
                  <p className="text-ui font-semibold text-fg">They will no longer be able to</p>
                  <ul className="mt-0.5 list-disc pl-5 text-ui">
                    {changeDiff.losses.map((g) => (
                      <li key={g}>{g.charAt(0).toLowerCase() + g.slice(1)}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {changeDiff.gains.length === 0 && changeDiff.losses.length === 0 ? <p>Nothing they can do changes.</p> : null}
              <p className="text-meta text-fg-3">It applies from their next request. You can change it back at any time.</p>
            </div>
          ) : null
        }
        confirmLabel="Change role"
        busy={busy}
        error={change ? error : null}
      />

      <ConfirmDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        onConfirm={() =>
          removing &&
          run(() => removeMember(organizationId, removing.id), `${removing.name} is removed`, () => setRemoving(null))
        }
        title={removing ? `Remove ${removing.name} from this workspace?` : "Remove this person?"}
        body={
          removing ? (
            <>
              <p>
                They lose access to every client and domain here on their next request. Their account and their other
                workspaces are untouched, and their past actions stay in the audit trail.
              </p>
              <p className="mt-2">Coming back takes a new invitation.</p>
            </>
          ) : null
        }
        confirmLabel="Remove from workspace"
        busy={busy}
        danger
        error={removing ? error : null}
      />

      <ConfirmDialog
        open={cancelling !== null}
        onClose={() => setCancelling(null)}
        onConfirm={() =>
          cancelling &&
          run(() => cancelInvitation(organizationId, cancelling.id), `Invitation for ${cancelling.email} withdrawn`, () => setCancelling(null))
        }
        title="Withdraw this invitation?"
        body={cancelling ? <p>{cancelling.email} can no longer use it to join. You can invite the address again later.</p> : null}
        confirmLabel="Withdraw invitation"
        busy={busy}
        error={cancelling ? error : null}
      />

      <Dialog
        open={transferOpen && successor !== null}
        onClose={() => {
          if (transferBusy) return;
          setTransferOpen(false);
          setTransferError(null);
        }}
        testId="transfer-owner-confirm"
        title={successor ? `Make ${successor.name} the owner?` : "Transfer ownership?"}
        footer={
          <>
            <Button
              variant="ghost"
              disabled={transferBusy}
              onClick={() => {
                setTransferOpen(false);
                setTransferError(null);
              }}
            >
              {refusal ? "Close" : "Cancel"}
            </Button>
            {refusal || previewError ? null : (
              <Button
                variant="danger"
                onClick={() => void transfer()}
                busy={transferBusy}
                busyLabel="Transfer ownership"
                disabled={!transferReady}
                data-testid="transfer-owner-confirm-button"
              >
                Transfer ownership
              </Button>
            )}
          </>
        }
      >
        {successor ? (
          <div className="flex flex-col gap-3 text-body text-fg-2">
            <p>
              {successor.name} becomes the owner and you become an admin, in one step. Only they can hand it back.
            </p>

            {previewError ? (
              <Notice tone="fail" title={previewError} />
            ) : !preview || !summary ? (
              <p className="text-ui text-fg-3" data-testid="transfer-owner-reading">
                Reading what the transfer would change.
              </p>
            ) : (
              <div data-testid="transfer-owner-plan" className="flex flex-col gap-1.5">
                <p className="text-body text-fg">{summary.sentence}</p>
                {summary.lower ? (
                  <ul className="flex flex-col gap-0.5 text-ui text-fg" data-testid="transfer-owner-stops">
                    {summary.stops.map((label) => (
                      <li key={label}>− {label}</li>
                    ))}
                    {summary.limits.map((line) => (
                      <li key={line} className="tnum">
                        − {line}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            )}

            {refusal ? (
              <Notice tone="fail" title="This transfer cannot go ahead" testId="transfer-owner-refusal">
                <p>{refusal.message}</p>
                {refusal.code === "SUBSCRIPTION_STILL_ACTIVE" ? (
                  <p className="mt-2 flex flex-wrap gap-x-4">
                    <Link href={refusal.details?.billingUrl ?? "/billing"} className="link font-semibold">
                      Open Billing
                    </Link>
                    <a href={refusal.details?.supportUrl ?? "/support"} className="link font-semibold">
                      Contact support
                    </a>
                  </p>
                ) : null}
              </Notice>
            ) : null}

            {transferReady ? (
              <>
              <Segmented
                label="Confirm with"
                size="sm"
                value={transferWith}
                onChange={(next) => {
                  setTransferWith(next);
                  setTransferProof("");
                  setTransferError(null);
                }}
                options={[
                  { value: "password", label: "Password" },
                  { value: "code", label: "Authenticator code" },
                ]}
              />
              <Field label={transferWith === "password" ? "Your password" : "Code from your authenticator app"}>
                <Input
                  type={transferWith === "password" ? "password" : "text"}
                  inputMode={transferWith === "code" ? "numeric" : undefined}
                  autoComplete={transferWith === "password" ? "current-password" : "one-time-code"}
                  value={transferProof}
                  onChange={(e) => setTransferProof(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void transfer();
                    }
                  }}
                  data-testid="transfer-owner-proof"
                />
              </Field>
              </>
            ) : null}

            {transferError ? (
              <p role="alert" className="text-ui font-medium text-fail">
                {transferError}
              </p>
            ) : null}
          </div>
        ) : null}
      </Dialog>
    </div>
  );
}
