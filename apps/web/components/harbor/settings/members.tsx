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
 */

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { cancelInvitation, inviteMember, removeMember, updateMemberRole } from "@/lib/ops-client";
import { ActionRefusal, type ActionError } from "@/components/harbor/plan-refusal";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/field";
import { Check } from "@/components/ui/icons";
import { Notice } from "@/components/ui/notice";
import { Table, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { Panel } from "./parts";

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

export interface MemberView {
  id: string;
  userId: string;
  role: string;
  name: string;
  email: string | null;
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
  canManage,
  selfUserId,
}: {
  organizationId: string;
  members: MemberView[];
  /** null when the pending list could not be read. */
  invitations: InvitationView[] | null;
  canManage: boolean;
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <div className="flex flex-col gap-10">
      <Panel id="people" title="People" aside={`${members.length} member${members.length === 1 ? "" : "s"}`}>
        <Table caption="Workspace members" minWidth={620}>
          <THead>
            <tr>
              <Th>Person</Th>
              <Th>Role</Th>
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
                  <Td>
                    <span className="block font-semibold">
                      {m.name}
                      {self ? <span className="ml-2 text-meta font-semibold text-act">You</span> : null}
                    </span>
                    {m.email ? <span className="data block text-meta text-fg-3">{m.email}</span> : null}
                  </Td>
                  <Td>
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
                    <span className="mt-0.5 block max-w-[46ch] text-meta text-fg-3">{ROLE_SUMMARY[role]}</span>
                  </Td>
                  <Td align="right" className="whitespace-nowrap">
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
                    ) : (
                      null
                    )}
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

      <Panel id="invite" title="Invite someone" why="Invite colleagues. Client contacts go under Client portal access, which limits them to their own client.">
        {canManage ? (
          <form onSubmit={invite} className="flex flex-col gap-3">
            <div className="flex flex-wrap items-end gap-3">
              <Field label="Email address" className="min-w-[min(100%,300px)] flex-1">
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
              <Field label="Role">
                <Select value={inviteRole} onChange={(e) => setInviteRole(e.target.value as Assignable)} data-testid="invite-role">
                  {ASSIGNABLE.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </Select>
              </Field>
              <Button type="submit" variant="primary" busy={inviteBusy} busyLabel="Recording the invitation">
                Invite
              </Button>
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

        <div className="mt-2">
          <h3 className="text-ui font-semibold text-fg">Waiting to be accepted</h3>
          {invitations === null ? (
            <Notice tone="warn" title="The pending invitations could not be read" className="mt-2">
              This is not the same as having none. Reload to try again.
            </Notice>
          ) : invitations.length === 0 ? (
            <p className="mt-1 text-ui text-fg-3">No invitation is waiting.</p>
          ) : (
            <ul data-testid="pending-invitations" className="mt-1 flex flex-col border-t border-rule">
              {invitations.map((inv) => (
                <li key={inv.id} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-rule py-2 text-ui">
                  <span className="data font-semibold text-fg">{inv.email}</span>
                  <span className="capitalize text-fg-2">{inv.role}</span>
                  <span className="text-meta text-fg-3">{inv.expiresLabel ? `Lapses ${inv.expiresLabel}` : "No end date recorded"}</span>
                  <span className="flex-1" />
                  {canManage ? (
                    <button
                      type="button"
                      className="link text-meta"
                      onClick={() => {
                        setError(null);
                        setCancelling(inv);
                      }}
                    >
                      Withdraw
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      </Panel>

      <Panel id="roles" title="What each role can do" why="The API checks these on every request. The page offers only what your role allows.">
        <Table caption="Capabilities by role" minWidth={720} dense>
          <THead>
            <tr>
              <Th>Capability</Th>
              {ROLES.map((r) => (
                <Th key={r} align="center" className="capitalize">
                  {r}
                </Th>
              ))}
            </tr>
          </THead>
          <TBody>
            {CAPABILITIES.map((c) => (
              <Tr key={c.label}>
                <Td>{c.label}</Td>
                {ROLES.map((r) => (
                  <Td key={r} align="center">
                    {c.roles.includes(r) ? (
                      <Check size={14} className="inline text-ok" aria-label="yes" />
                    ) : (
                      <span className="text-fg-4" aria-label="no">
                        —
                      </span>
                    )}
                  </Td>
                ))}
              </Tr>
            ))}
          </TBody>
        </Table>
      </Panel>

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
