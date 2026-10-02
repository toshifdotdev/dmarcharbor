/**
 * auth-client.ts — browser-side auth calls. Better Auth owns the endpoints and
 * the session cookie; this is only the request glue.
 */

const BASE = "";

export async function signIn(email: string, password: string): Promise<void> {
  const res = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error((await readError(res)) ?? "Sign-in failed.");
}

export async function signUp(
  name: string,
  email: string,
  password: string,
): Promise<void> {
  const res = await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ name, email, password }),
  });
  if (!res.ok) throw new Error((await readError(res)) ?? "Sign-up failed.");
}

export async function signOut(): Promise<void> {
  await fetch(`${BASE}/api/auth/sign-out`, {
    method: "POST",
    credentials: "include",
  });
}

async function readError(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    return body.error?.message;
  } catch {
    return undefined;
  }
}
