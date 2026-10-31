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
 * delete the workspace and change the plan, and the API offers no transfer.
 *
 * Invitations are emailed by the API (sendInvitationEmail) with a link to
 * /welcome, where the invited address finds them; the portfolio lists them too.
 * A pending one can be sent again (the plugin's own resend: same invitation,
 * new expiry, new email) or withdrawn.
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
  setWorkspaceMfaRequirement,
  updateMemberRole,
} from "@/lib/ops-client";
import type { WorkspaceSecurity } from "@/lib/types";
import { ActionRefusal, type ActionError } from "@/components/harbor/plan-refusal";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/field";
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
  { label: "Delete the workspace", roles: ["owner"] },
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
}

export function MembersBoard({
  organizationId,
  members,
  invitations,
  security,
  canManage,
  isOwner,
  selfUserId,
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
}) {
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
                          variant="ghost"
                          className="text-fail hover:text-fail"
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
          invitations && invitations.length > 0 ? (
            <span className="tnum">{plural(invitations.length, "invitation")} waiting</span>
          ) : null
        }
      >
        {canManage ? (
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
          {invitations === null ? (
            <Notice tone="warn" title="The pending invitations could not be read" className="mt-2">
              This is not the same as having none. Reload to try again.
            </Notice>
          ) : invitations.length === 0 ? (
            <p className="mt-1 text-ui text-fg-3">No invitation is waiting.</p>
          ) : (
            <ul data-testid="pending-invitations" className="mt-2 flex flex-col border-t border-rule">
              {invitations.map((inv) => (
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
                    <span className="col-start-3 row-start-1 flex items-baseline gap-3 text-meta sm:col-start-auto sm:row-start-auto">
                      {isAssignable(inv.role) ? (
                        <button
                          type="button"
                          className="link disabled:opacity-60"
                          disabled={resending !== null}
                          data-testid={`resend-invitation-${inv.id}`}
                          aria-label={`Send the invitation to ${inv.email} again`}
                          onClick={() => void resend(inv)}
                        >
                          {resending === inv.id ? "Sending" : "Resend"}
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="link"
                        onClick={() => {
                          setError(null);
                          setCancelling(inv);
                        }}
                      >
                        Withdraw
                      </button>
                    </span>
                  ) : (
                    <span />
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </Panel>

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
    </div>
  );
}
