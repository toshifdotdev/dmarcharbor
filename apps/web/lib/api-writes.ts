/**
 * api-writes.ts — server-side mutations. Kept separate from api.ts so any
 * page importing a mutation does so explicitly.
 */

import { cookies } from "next/headers";

const API_BASE = process.env.API_BASE_URL ?? "http://localhost:4000";

export async function createWorkspace(body: {
  name: string;
  slug: string;
}): Promise<void> {
  const jar = await cookies();
  const header = new Headers({ "content-type": "application/json" });
  const session = jar.get("better-auth.session_token");
  if (session) header.set("cookie", `better-auth.session_token=${session.value}`);

  const res = await fetch(`${API_BASE}/api/workspaces`, {
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
}
