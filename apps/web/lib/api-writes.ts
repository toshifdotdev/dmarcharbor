/**
 * api-writes.ts â€” server-side mutations. Kept separate from api.ts so any
 * page importing a mutation does so explicitly.
 */

import { API_BASE, apiFetch } from "./api-fetch";
import { cookies } from "next/headers";


/** POST /api/workspaces/:id/dpa-acceptance â€” records an acceptance against a
 *  workspace that already exists.
 *
 *  NOT used by onboarding any more. Workspace creation now sends both confirmations on
 *  the POST itself, because the version that used this as a follow-up was reached only
 *  on the happy path and so left workspaces standing with no acceptance record whenever
 *  anything failed in between.
 *
 *  It exists for re-consent: when the agreement is revised, `dpaAcceptanceFor()` reports
 *  `requiresReconsent` for everyone who accepted the previous version, and someone has
 *  to be able to record the new acceptance. That flow has no UI yet, which is why this
 *  function currently has no caller. It is left here rather than deleted so the endpoint
 *  has a client the moment that screen is built, and so its contract is visible. */
export async function acceptDpa(
  organizationId: string,
  body: { hasRead: boolean; confirmsAuthority: boolean },
): Promise<void> {
  const jar = await cookies();
  const header = new Headers({ "content-type": "application/json" });
  const session = jar.get("better-auth.session_token");
  if (session) header.set("cookie", `better-auth.session_token=${session.value}`);

  const res = await apiFetch(
    `${API_BASE}/api/workspaces/${organizationId}/dpa-acceptance`,
    {
      method: "POST",
      headers: header,
      body: JSON.stringify(body),
      cache: "no-store",
      credentials: "include",
    },
  );
  if (!res.ok) {
    let message = `The DPA acceptance could not be recorded (${res.status}).`;
    try {
      const body2 = (await res.json()) as { error?: { message?: string } };
      if (body2.error?.message) message = body2.error.message;
    } catch {
      // keep default message
    }
    throw new Error(message);
  }
}

export async function createWorkspace(body: {
  name: string;
  slug: string;
  /**
   * The two Data Processing Agreement confirmations, required by the API.
   *
   * They are sent on the creation call rather than recorded afterwards because that is
   * the only arrangement where refusing is possible. A follow-up call can simply be
   * skipped, and this one was: the welcome screen ticked both boxes, created the
   * workspace, and the acceptance was left unrecorded. Every workspace therefore had
   * `dpaAcceptedAt: null` while the UI implied it had been agreed to.
   *
   * This function only exists to serve the welcome flow, which validates both boxes
   * before it gets here, so the flags are required in the type rather than defaulted.
   * A caller that has not established the agreement should not be able to compile.
   */
  dpaHasRead: true;
  dpaConfirmsAuthority: true;
}): Promise<{ id: string } | null> {
  const jar = await cookies();
  const header = new Headers({ "content-type": "application/json" });
  const session = jar.get("better-auth.session_token");
  if (session) header.set("cookie", `better-auth.session_token=${session.value}`);

  const res = await apiFetch(`${API_BASE}/api/workspaces`, {
    method: "POST",
    headers: header,
    body: JSON.stringify(body),
    cache: "no-store",
    credentials: "include",
  });
  if (!res.ok) {
    let message = `Workspace creation failed (${res.status})`;
    try {
      const body2 = (await res.json()) as { error?: { message?: string } };
      if (body2.error?.message) message = body2.error.message;
    } catch {
      // keep default message
    }
    throw new Error(message);
  }
  // The response is the created organization: the id is what records the DPA
  // acceptance against, so the caller needs it rather than a void.
  const created = (await res.json().catch(() => null)) as { id?: string } | null;
  return created && typeof created.id === "string" ? { id: created.id } : null;
}
