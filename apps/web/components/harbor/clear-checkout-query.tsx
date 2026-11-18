"use client";

/**
 * clear-checkout-query.tsx — forgets how the person arrived on Billing.
 *
 * A payment provider returns to /billing?checkout=complete&status=…, and the
 * page reads that once to say what just happened. Left in the address bar, every
 * refresh, bookmark or later visit said it again: "Payment sent to the provider"
 * stayed on screen after the plan was confirmed, and after it was cancelled.
 * Next's router follows window.history.replaceState, so a later refresh renders
 * the page from the subscription alone.
 */
import { useEffect } from "react";

const RETURN_PARAMS = ["checkout", "status", "subscription_id", "payment_id", "email"];

export function ClearCheckoutQuery() {
  useEffect(() => {
    const url = new URL(window.location.href);
    if (!RETURN_PARAMS.some((name) => url.searchParams.has(name))) return;
    for (const name of RETURN_PARAMS) url.searchParams.delete(name);
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }, []);
  return null;
}
