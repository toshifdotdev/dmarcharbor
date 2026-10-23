/**
 * auth-client.ts — browser-side auth calls. Better Auth owns the endpoints and
 * the session cookie (through the same-origin /api proxy); this is only the
 * request glue and the human wording of its answers.
 *
 * Every call that can cause a link to be emailed passes an ABSOLUTE
 * callbackURL on this origin. Better Auth resolves a relative one against its
 * own base URL, which is the API host, so a relative "/welcome" would land the
 * person on the API after clicking the link. The origin is read at call time
 * because one build serves the product domain and every agency domain.
 */

const BASE = "";

/**
 * Human copy for the failures Better Auth can return.
 *
 * A wrong password and an unknown address deliberately answer with the same
 * sentence: telling them apart turns the sign-in form into a list of who has
 * an account. Everything else is a validator message that was shown raw.
 */
const MESSAGES: Record<string, string> = {
  INVALID_EMAIL_OR_PASSWORD: "That email and password combination does not match an account.",
  INVALID_EMAIL: "That does not look like an email address.",
  PASSWORD_TOO_SHORT: "Use a password of at least 8 characters.",
  PASSWORD_TOO_LONG: "Use a password of at most 128 characters.",
  VALIDATION_ERROR: "Fill in both the email and the password.",
  INVALID_TOKEN: "This reset link is not valid any more. Ask for a new one below.",
  EMAIL_NOT_VERIFIED: "This email address is not verified yet. We have sent a fresh verification link to it.",
};

export class AuthError extends Error {
  readonly code: string | undefined;
  readonly status: number;
  constructor(message: string, code: string | undefined, status: number) {
    super(message);
    this.name = "AuthError";
    this.code = code;
    this.status = status;
  }
}

function messageFor(code: string | undefined, fallback: string | undefined, status: number): string {
  if (code && MESSAGES[code]) return MESSAGES[code];
  if (status === 429) return "Too many attempts. Wait a minute and try again.";
  if (fallback) return fallback;
  return "That did not work. Try again.";
}

function origin(): string {
  return typeof window === "undefined" ? "" : window.location.origin;
}

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${BASE}/api/auth/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
}

async function fail(res: Response): Promise<never> {
  let code: string | undefined;
  let message: string | undefined;
  try {
    const body = (await res.json()) as { error?: { message?: string; code?: string }; message?: string; code?: string };
    // Better Auth puts the code in one of two places depending on the route.
    code = body.error?.code ?? body.code;
    message = body.error?.message ?? body.message;
  } catch {
    /* body unreadable: the status is all there is */
  }
  throw new AuthError(messageFor(code, message, res.status), code, res.status);
}

/** `returnTo` is the same-site path to land on after an emailed link. */
export async function signIn(email: string, password: string, returnTo = "/"): Promise<void> {
  const res = await post("sign-in/email", { email, password, callbackURL: `${origin()}${returnTo}` });
  if (!res.ok) await fail(res);
}

/**
 * Never reports whether the address was free: Better Auth answers 200 with a
 * synthetic user when the email already has an account, on purpose, so the
 * form cannot enumerate who is registered. The caller only ever learns that a
 * link was sent if one could be.
 */
export async function signUp(name: string, email: string, password: string): Promise<void> {
  const res = await post("sign-up/email", { name, email, password, callbackURL: `${origin()}/welcome` });
  if (!res.ok) await fail(res);
}

/** Sends another verification link. Answers the same whether or not the
 *  address has an account. */
export async function resendVerification(email: string): Promise<void> {
  const res = await post("send-verification-email", { email, callbackURL: `${origin()}/welcome` });
  if (!res.ok) await fail(res);
}

/** Emails a reset link that lands back on /sign-in with a token. Answers the
 *  same whether or not the address has an account. */
export async function requestPasswordReset(email: string): Promise<void> {
  const res = await post("request-password-reset", { email, redirectTo: `${origin()}/sign-in` });
  if (!res.ok) await fail(res);
}

/** Sets a new password with the token from the reset link. Every other session
 *  for the account is revoked by the API on success. */
export async function resetPassword(token: string, newPassword: string): Promise<void> {
  const res = await post("reset-password", { token, newPassword });
  if (!res.ok) await fail(res);
}

export async function signOut(): Promise<void> {
  await fetch(`${BASE}/api/auth/sign-out`, {
    method: "POST",
    credentials: "include",
  });
}
