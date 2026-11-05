/**
 * invitations.ts — open and expired invitations, told apart.
 *
 * The plugin keeps an invitation "pending" after it expires, and the members
 * page listed those under "Waiting to be accepted" and counted them as
 * waiting, although nobody can accept one any more. An expired invitation is
 * shown under its own heading, with Resend and Withdraw, and holds no place on
 * the team: the API's seat count ignores it too (memberAllowance).
 */

export interface InvitationRow {
  id: string;
  email: string;
  role: string;
  status?: string | null;
  expiresAt?: string | null;
}

/** Still pending to the plugin, but past its expiry. No expiry is never expired. */
export function invitationExpired(row: Pick<InvitationRow, "expiresAt">, now: number): boolean {
  if (!row.expiresAt) return false;
  const at = new Date(row.expiresAt).getTime();
  return Number.isFinite(at) && at <= now;
}

/** Pending invitations split into those that can still be accepted and those that expired. */
export function splitInvitations<T extends InvitationRow>(rows: T[], now: number): { waiting: T[]; expired: T[] } {
  const pending = rows.filter((row) => !row.status || row.status === "pending");
  return {
    waiting: pending.filter((row) => !invitationExpired(row, now)),
    expired: pending.filter((row) => invitationExpired(row, now)),
  };
}
