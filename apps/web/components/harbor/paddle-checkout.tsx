"use client";

/**
 * paddle-checkout.tsx — opens a Paddle transaction over our /pay page.
 *
 * Paddle.js reads `?_ptxn=` itself and opens the checkout overlay for that
 * transaction once it is initialised, so this component only loads the
 * script, initialises it with the client-side token (sandbox for a `test_`
 * token) and listens: a completed checkout goes to the billing page, which
 * waits for the webhook; a closed one goes back to it as cancelled. Nothing
 * here marks anything paid.
 *
 * The script is added by our own code after hydration, so the page's
 * nonce-based CSP admits it through 'strict-dynamic'; proxy.ts widens frame,
 * connect, style and image sources to Paddle on this route only.
 *
 * Test hooks: pay-waiting, pay-open, pay-error.
 */

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { LoadingState } from "@/components/ui/states";

type PaddleEvent = { name?: string };
type PaddleGlobal = {
  Environment: { set: (env: "sandbox" | "production") => void };
  Initialize: (options: {
    token: string;
    checkout?: { settings?: Record<string, unknown> };
    eventCallback?: (event: PaddleEvent) => void;
  }) => void;
  Checkout: { open: (options: { transactionId: string; settings?: Record<string, unknown> }) => void };
};

const SCRIPT = "https://cdn.paddle.com/paddle/v2/paddle.js";

export function PaddleCheckout({ transactionId, clientToken }: { transactionId: string | null; clientToken: string | null }) {
  const [phase, setPhase] = useState<"loading" | "open" | "error">(transactionId && clientToken ? "loading" : "error");
  const [message, setMessage] = useState<string | null>(null);
  const completed = useRef(false);

  function open() {
    const paddle = (window as unknown as { Paddle?: PaddleGlobal }).Paddle;
    if (paddle && transactionId) paddle.Checkout.open({ transactionId });
  }

  useEffect(() => {
    if (!transactionId || !clientToken) return;
    const successUrl = `${window.location.origin}/billing?checkout=complete`;
    const start = () => {
      const paddle = (window as unknown as { Paddle?: PaddleGlobal }).Paddle;
      if (!paddle) {
        setPhase("error");
        setMessage("The payment form could not be loaded. Check your connection and try again.");
        return;
      }
      if (clientToken.startsWith("test_")) paddle.Environment.set("sandbox");
      paddle.Initialize({
        token: clientToken,
        checkout: { settings: { displayMode: "overlay", theme: "light", successUrl, allowLogout: false } },
        eventCallback: (event) => {
          if (event.name === "checkout.loaded") setPhase("open");
          if (event.name === "checkout.completed") completed.current = true;
          if (event.name === "checkout.closed" && !completed.current) {
            window.location.href = `${window.location.origin}/billing?checkout=cancelled`;
          }
        },
      });
    };
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${SCRIPT}"]`);
    if (existing) {
      start();
      return;
    }
    const script = document.createElement("script");
    script.src = SCRIPT;
    script.async = true;
    script.onload = start;
    script.onerror = () => {
      setPhase("error");
      setMessage("The payment form could not be loaded. Check your connection and try again.");
    };
    document.head.appendChild(script);
  }, [transactionId, clientToken]);

  return (
    <main className="page-wrap flex min-h-[70vh] flex-col items-center justify-center gap-6 py-16 text-center">
      <div className="flex max-w-[34rem] flex-col gap-2">
        <h1 className="display text-h1 text-fg">Payment</h1>
        <p className="text-lead text-fg-2">
          The payment form is provided by Paddle, which handles the card and the receipt. Your plan changes once Paddle
          confirms the payment.
        </p>
      </div>
      {phase === "error" ? (
        <div data-testid="pay-error" className="w-full max-w-[34rem] text-left">
          <Notice tone="warn" title="This payment cannot be opened here">
            {message ??
              (!transactionId
                ? "The link is missing its payment reference. Start again from the Billing page."
                : "Payments are not set up on this deployment yet.")}
          </Notice>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-4" data-testid={phase === "open" ? "pay-open" : "pay-waiting"}>
          {phase === "loading" ? <LoadingState label="Opening the payment form" /> : null}
          <Button variant="secondary" onClick={open}>
            Open the payment form again
          </Button>
          <a href="/billing" className="link text-ui">
            Back to Billing
          </a>
        </div>
      )}
    </main>
  );
}
