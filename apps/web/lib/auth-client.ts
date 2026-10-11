/**
 * auth-client.ts — browser-side auth calls. Better Auth owns the endpoints and
 * the session cookie; this is only the request glue.
 */

const BASE = "";

/**
 * Human copy for the failures Better Auth can return.
 *
 * Two of these are deliberate and must not be "improved": a wrong password and
 * an unknown address answer with the same sentence, because distinguishing them
 * turns the sign-in form into a list of who has an account. Everything else is a
 * validator message that was being shown raw to the operator.
 */
const MESSAGES: Record<string, string> = {
  INVALID_EMAIL_OR_PASSWORD: "That email and password combination does not match an account.",
  INVALID_EMAIL: "That does not look like an email address.",
  PASSWORD_TOO_SHORT: "Use a password of at least 8 characters.",
  VALIDATION_ERROR: "Fill in both the email and the password.",
};

function messageFor(code: string | undefined, fallback: string | undefined, status: number): string {
  if (code && MESSAGES[code]) return MESSAGES[code];
  if (fallback) return fallback;
  if (status === 429) return "Too many attempts. Wait a minute and try again.";
  return "That did not work. Try again.";
}

export async function signIn(email: string, password: string): Promise<void> {
  const res = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(await readError(res));
}

export async function signUp(
  name: string,
  email: string,
  password: string,
): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ name, email, password }),
  });
  if (!res.ok) throw new Error(await readError(res));
  /**
   * Never reports whether the address was free.
   *
   * Better Auth answers 200 with a synthetic user when the email already has an
   * account, on purpose, so the form cannot be used to enumerate who is
   * registered. There is therefore no "already exists" to show, and the caller is
   * told only what is certainly true either way.
   */
  return "If an account can be created for this email, a verification link is on its way. If you already have an account, sign in instead.";
}

export async function signOut(): Promise<void> {
  await fetch(`${BASE}/api/auth/sign-out`, {
    method: "POST",
    credentials: "include",
  });
}

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as {
      error?: { message?: string; code?: string };
      message?: string;
      code?: string;
    };
    // Better Auth puts the code in one of two places depending on the route.
    const code = body.error?.code ?? body.code;
    const message = body.error?.message ?? body.message;
    return messageFor(code, message, res.status);
  } catch {
    return messageFor(undefined, undefined, res.status);
  }
}
