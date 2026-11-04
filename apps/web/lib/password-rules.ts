/**
 * password-rules.ts — the one length rule every new password follows.
 *
 * The API enforces 8 to 128 characters (Better Auth's emailAndPassword
 * options) and refuses a password found in a known breach; the breach check
 * needs the server, so only the length is checked here. Sign-up, the reset
 * form and the change-password form all count with this, so the three can
 * never disagree about what "long enough" means.
 */
export const MIN_PASSWORD = 8;
export const MAX_PASSWORD = 128;

export type PasswordLength = "empty" | "short" | "ok";

export function passwordLength(value: string): PasswordLength {
  if (value.length === 0) return "empty";
  return value.length < MIN_PASSWORD ? "short" : "ok";
}

/** The live hint under a new-password field: "At least 8 characters · 6 so far." */
export function passwordLengthHint(value: string): string {
  if (value.length >= MIN_PASSWORD) return "Long enough.";
  return `At least ${MIN_PASSWORD} characters${value.length ? ` · ${value.length} so far` : ""}.`;
}

export type SignInProvider = "google" | "microsoft" | "sso";

const PROVIDER_NAME: Record<SignInProvider, string> = {
  google: "Google",
  microsoft: "Microsoft",
  sso: "your company's single sign-on",
};

/**
 * How an account without a password signs in, in words: "Google",
 * "Google or Microsoft", "Google, Microsoft or your company's single sign-on".
 * With none reported (an older API), the two social providers.
 */
export function signInProviderList(providers: readonly SignInProvider[]): string {
  const names = [...new Set(providers)].map((p) => PROVIDER_NAME[p]);
  if (names.length === 0) return "Google or Microsoft";
  if (names.length === 1) return names[0]!;
  return `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`;
}

/**
 * Why a change-password form cannot be sent yet, or null when it can. The
 * server says the same things; saying them first saves a round trip.
 */
export function changePasswordProblem(current: string, next: string): string | null {
  if (!current) return "Enter your current password.";
  if (passwordLength(next) !== "ok") return `Use a new password of at least ${MIN_PASSWORD} characters.`;
  if (next.length > MAX_PASSWORD) return `Use a new password of at most ${MAX_PASSWORD} characters.`;
  if (next === current) return "The new password must be different from the current password.";
  return null;
}
