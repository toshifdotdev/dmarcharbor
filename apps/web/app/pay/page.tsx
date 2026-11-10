import type { Metadata } from "next";
import { PaddleCheckout } from "@/components/harbor/paddle-checkout";

export const metadata: Metadata = { title: "Payment", robots: { index: false, follow: false } };

/**
 * /pay — where a Paddle checkout opens.
 *
 * Paddle sends a customer to the account's default payment link with
 * `?_ptxn=<transaction id>`: from our billing page after "Continue to payment",
 * and from Paddle's own emails (a renewal that needs a new card, an invoice to
 * pay). The page loads Paddle.js and opens that transaction; Paddle takes the
 * card, and the webhook, not this page, is what changes the plan.
 *
 * Public on purpose: a link in an email opens before anyone signs in, and the
 * transaction id carries nothing a stranger could use except to pay it.
 */
export default async function PayPage({ searchParams }: { searchParams: Promise<{ _ptxn?: string }> }) {
  const { _ptxn } = await searchParams;
  const transactionId = typeof _ptxn === "string" && /^txn_[a-z0-9]{26}$/.test(_ptxn) ? _ptxn : null;
  return <PaddleCheckout transactionId={transactionId} clientToken={process.env.NEXT_PUBLIC_PADDLE_CLIENT_TOKEN ?? null} />;
}
