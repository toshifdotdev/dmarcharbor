/**
 * sending-domain.ts — what the email provider's word on an agency's own
 * sending domain means, in the three states the settings page says.
 *
 * The provider (Resend) reports `not_started`, `pending`, `verified`,
 * `partially_verified`, `partially_failed`, `failed` and `temporary_failure`,
 * for the domain and for each record. The agency needs to know one thing: is
 * client email coming from this address yet. So:
 *
 *   verified  the API holds the domain as verified (`verified: true`), which
 *             is what switches client email to the address.
 *   failed    the provider looked and the records are wrong.
 *   waiting   anything else, unknown statuses included: the address is not
 *             used yet, and client email keeps coming from the shared address.
 *
 * Pure, so it is unit-tested (tests/sending-domain.test.ts).
 */

export type SendingPhase = "verified" | "waiting" | "failed";

const FAILED = new Set(["failed", "partially_failed"]);

/** The domain's overall state. Only the API's `verified` flag says "verified". */
export function sendingDomainPhase(state: { status: string | null | undefined; verified: boolean }): SendingPhase {
  if (state.verified) return "verified";
  if (state.status && FAILED.has(state.status)) return "failed";
  return "waiting";
}

/** One record's state, from its own provider status. */
export function sendingRecordPhase(status: string | null | undefined): SendingPhase {
  if (status === "verified") return "verified";
  if (status && FAILED.has(status)) return "failed";
  return "waiting";
}

/** What a "Check records" answer says, beside the button. */
export function sendingCheckNotice(state: {
  sendingAddress: string | null;
  status: string | null;
  verified: boolean;
}): { tone: "ok" | "warn" | "fail"; text: string } {
  const phase = sendingDomainPhase(state);
  if (phase === "verified") {
    return {
      tone: "ok",
      text: `Your email provider has seen the records. Client email now comes from ${state.sendingAddress ?? "your address"}.`,
    };
  }
  if (phase === "failed") {
    return {
      tone: "fail",
      text: "Your email provider could not verify the records. Check that each one below is published exactly as shown, then check again.",
    };
  }
  return {
    tone: "warn",
    text: "Your email provider has not seen the records yet. Publishing can take a few minutes; check again shortly.",
  };
}

/** The domain of a `local@domain` address, for the relative host label beside each record. */
export function sendingDomainOf(address: string | null | undefined): string | null {
  if (!address) return null;
  const at = address.lastIndexOf("@");
  return at > 0 && at < address.length - 1 ? address.slice(at + 1).toLowerCase() : null;
}
