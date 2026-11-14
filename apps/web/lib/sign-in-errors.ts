/**
 * sign-in-errors.ts — what the sign-in page says for an `?error=` code.
 *
 * Codes arrive from three places:
 * - our own links (`verify_expired` and `verify_invalid` from /welcome, `social`
 *   as the placeholder the social start used to send);
 * - Better Auth's reset link (`INVALID_TOKEN`);
 * - Better Auth's OAuth callback, through its `errorCallbackURL` or, when the
 *   state itself is unusable, through `onAPIError.errorURL` (auth.config.ts).
 *   Those are lower-case codes, and a free-text failure is turned into one by
 *   joining its words with underscores ("account not linked").
 *
 * An unknown code still gets a sentence that says to try again, never the code.
 */

const PROVIDER_RETRY = "Try again, or sign in with email.";

const MESSAGES: Record<string, string> = {
  social: `That sign-in did not complete with the provider. ${PROVIDER_RETRY}`,
  INVALID_TOKEN: "That reset link is not valid any more: it was used already or it is over an hour old. Ask for a new one.",
  unable_to_create_session:
    "This account uses two-step verification. Sign in with your email, password and authenticator code.",
  // From /welcome, where Better Auth returns a verification link that failed.
  // Signing in with an unverified address sends a fresh link, so that is the
  // next step either way.
  verify_expired:
    "That verification link has expired. Sign in with your email and password, and if the address still needs verifying we will send a fresh link.",
  verify_invalid:
    "That verification link did not work: it may have been used already or copied incompletely. Sign in, and if the address still needs verifying we will send a fresh link.",

  // The provider round trip lost its place: an old tab, the back button, or a
  // sign-in started in another browser.
  state_mismatch: `That sign-in was started in another tab or has already been used, so it could not finish. ${PROVIDER_RETRY}`,
  state_not_found: `That sign-in took too long or was already finished, so it could not complete. ${PROVIDER_RETRY}`,
  invalid_callback_request: `The provider sent back something we could not read. ${PROVIDER_RETRY}`,
  please_restart_the_process: `That sign-in could not finish. ${PROVIDER_RETRY}`,
  no_code: `The provider did not finish the sign-in. ${PROVIDER_RETRY}`,
  invalid_code: `The provider's sign-in code had expired or was already used. ${PROVIDER_RETRY}`,
  access_denied: "You cancelled the sign-in at the provider, or it was refused there. Nothing was changed.",
  unable_to_get_user_info: `The provider did not tell us who you are. ${PROVIDER_RETRY}`,
  email_not_found:
    "The provider did not share an email address for this account, so it cannot be used to sign in here. Sign in with email instead.",
  email_not_verified:
    "Confirm your email address first. We have sent a verification link to the address on that account: open it, then sign in again.",
  account_not_linked:
    "An account with this email already exists and is not connected to that provider. Sign in with your email and password instead.",
  unable_to_link_account: `That provider account could not be connected to yours. ${PROVIDER_RETRY}`,
  account_already_linked_to_different_user:
    "That provider account is already connected to a different account here. Sign in with that account, or with email.",
  email_does_not_match: "That provider account uses a different email address from this account. Use the matching one.",
  signup_disabled: "New accounts cannot be created that way. Sign in with an existing account, or create one with email.",
  unable_to_create_user:
    "The account could not be created that way. If your provider does not confirm your email address, create the account with your email address and a password instead.",
  oauth_provider_not_found: "That way of signing in is not available. Sign in with email.",
  issuer_mismatch: `The provider's answer did not match the sign-in that was started. ${PROVIDER_RETRY}`,
  issuer_missing: `The provider's answer did not say who sent it. ${PROVIDER_RETRY}`,
  nonce_binding_missing: `The provider's answer could not be matched to this sign-in. ${PROVIDER_RETRY}`,
  no_callback_url: `That sign-in did not say where to return to. ${PROVIDER_RETRY}`,
  internal_server_error: "Something failed on our side while signing you in. Try again in a moment.",

  // Single sign-on (api sso.controller.ts failToSignIn): our own codes, lower-cased.
  sso_domain_not_permitted:
    "Your provider signed you in, but your email address is not at a domain this workspace lets in through single sign-on. Ask the workspace's administrator to add your domain or to invite you.",
  sso_email_invalid:
    "Your provider signed you in, but your email address is not at a domain this workspace lets in through single sign-on. Ask the workspace's administrator to add your domain or to invite you.",
  sso_provisioning_disabled:
    "This workspace lets only invited people in through single sign-on. Ask its administrator for an invitation.",
  sso_not_provisionable: "Your account is not a member of this workspace. Ask its administrator for an invitation.",
  sso_member_limit: "This workspace has no room for another member on its plan. Ask its administrator.",
  sso_not_in_plan:
    "Single sign-on is not included in this workspace's plan. Sign in with your email and password; if you have never set one, use Forgot password.",
  sso_not_found:
    "That single sign-on link is not in use: it was switched off or removed. Ask your administrator for the current one, or sign in with email.",
  sso_email_missing:
    "Your provider did not share an email address, so you cannot be signed in. Ask your administrator to send the email claim.",
  sso_state_invalid: "That sign-in was started in another tab or has already been used. Start again from your company's sign-in link.",
  sso_state_expired: "That sign-in took too long. Start again from your company's sign-in link.",
  sso_relay_state_invalid: "That sign-in was started in another tab or has already been used. Start again from your company's sign-in link.",
  sso_relay_state_expired: "That sign-in took too long. Start again from your company's sign-in link.",
  sso_in_response_to_invalid: "That sign-in response does not match one we started. Start again from your company's sign-in link.",
  sso_response_invalid:
    "Your provider's answer could not be verified, so you were not signed in. If it happens again, ask your administrator to check the connection.",
  sso_config_invalid:
    "Single sign-on for this workspace is not set up correctly, so you were not signed in. Ask its administrator to check the connection.",
  sso_protocol_mismatch:
    "Single sign-on for this workspace is not set up correctly, so you were not signed in. Ask its administrator to check the connection.",
  sso_error: "That single sign-on attempt could not finish. Start again from your company's sign-in link; if it keeps failing, ask your administrator.",
};

/**
 * The sentence for an `?error=` value, or null when there is none.
 *
 * Better Auth appends its own code to an errorCallbackURL that already had one,
 * so the value can be a list. The last entry is the actual outcome.
 */
export function signInErrorMessage(error: string | string[] | undefined | null): string | null {
  const code = Array.isArray(error) ? error.at(-1) : error;
  if (!code) return null;
  const known = MESSAGES[code];
  if (known) return known;
  if (Array.isArray(error) && error.includes("social")) return MESSAGES.social!;
  return "That did not work. Try again.";
}
