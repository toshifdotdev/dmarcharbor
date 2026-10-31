"use client";

/**
 * assistant-widget.tsx — questions about the product, from a small window in
 * the bottom-right corner of the app.
 *
 * Built for the questions an MSP's staff ask between tickets: how a setup
 * step goes, what a figure on a report means, when to move a client to
 * reject, what each plan includes, how API keys and white label work, where a
 * setting lives. Answers come only from the product's own documentation, and
 * every answer shows the pages it came from, so it can be checked and
 * forwarded.
 *
 * THE LAUNCHER. An ink pill, "Ask", fixed to the corner. Its mark is a
 * question mark drawn as a line on the map: the hook is a line with a 45°
 * bend and the dot is a station. Open, the same pill reads "Close" with a
 * cross, so one button opens and closes it; the window has its own close
 * button too, and Escape closes it from inside.
 *
 * THE WINDOW. Opens above the launcher: 380px wide on a desktop, the width
 * of the screen less 8px a side on a phone, never taller than the space
 * under the app's header. Non-modal on purpose: the page stays usable, so a
 * technician can follow an answer in the app while it is still on screen.
 * Closing it keeps the conversation; reopening shows it again.
 *
 * WHAT IT DOES NOT COVER. The app shell reserves the corner (--hb-dock): the
 * footer gets that much extra space at the bottom, so its links scroll clear
 * of the launcher, and toasts rise above it. It prints as nothing.
 *
 * Plain on purpose: no name, no persona, no avatar, no chat bubbles and no
 * typing effect. A question is set in ink, its answer below it, the sources
 * under that as map labels (bold page, lighter section). "I don't know" is set
 * as plainly as an answer, with the way to support beside it.
 *
 * Nothing is read until the window first opens. A plan without the assistant
 * sees the API's own refusal, which names the plan that carries it; a failed
 * read says so instead of claiming the plan lacks it.
 *
 * Test hooks: assistant-open (the launcher), assistant-window (the window),
 * assistant-close, assistant-input, assistant-ask, assistant-log,
 * assistant-exchange, assistant-answer, assistant-unanswered,
 * assistant-source, assistant-starters, assistant-support,
 * assistant-links-mode.
 */

import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent, type RefObject } from "react";
import { clsx } from "clsx";
import {
  askAssistant,
  getAssistantIntro,
  type AssistantIntro,
  type AssistantReply,
  type AssistantSource,
} from "@/lib/assistant-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { Close, External } from "@/components/ui/icons";
import { Notice } from "@/components/ui/notice";
import { TideMark } from "@/components/ui/tide";
import { ActionRefusal, isPlanRefusal, type ActionError } from "../plan-refusal";

/** The address support answers at, until the API has said its own. */
const FALLBACK_SUPPORT = { url: "/support", email: "support@dmarcharbor.com" };

/** Exchanges kept on screen; older ones drop off the top. */
const KEEP = 8;

type Load =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "ready"; intro: AssistantIntro }
  | { state: "refused"; error: ActionError }
  | { state: "failed"; message: string };

interface Exchange {
  id: number;
  question: string;
  reply: AssistantReply | null;
}

export function AssistantWidget({ organizationId, brand }: { organizationId: string; brand: string }) {
  const [open, setOpen] = useState(false);
  const [load, setLoad] = useState<Load>({ state: "idle" });
  const launcher = useRef<HTMLButtonElement | null>(null);
  const heading = useRef<HTMLHeadingElement | null>(null);
  const windowId = useId();
  const titleId = useId();
  const aboutId = useId();

  // A different workspace may be on a different plan.
  useEffect(() => setLoad({ state: "idle" }), [organizationId]);

  useEffect(() => {
    if (!open || load.state !== "idle") return;
    setLoad({ state: "loading" });
    void getAssistantIntro(organizationId).then((r) => {
      if (r.ok) setLoad({ state: "ready", intro: r.data });
      else if (isPlanRefusal(r.error)) setLoad({ state: "refused", error: r.error });
      else setLoad({ state: "failed", message: r.error.message ?? "The service could not be reached." });
    });
  }, [open, load.state, organizationId]);

  // Until the conversation can take focus, the window's heading holds it, so
  // a screen reader lands inside what just opened.
  useEffect(() => {
    if (open && load.state !== "ready") heading.current?.focus();
  }, [open, load.state]);

  const close = useCallback(() => {
    setOpen(false);
    // A failed read is tried again on the next open, never in a loop.
    setLoad((current) => (current.state === "failed" ? { state: "idle" } : current));
    requestAnimationFrame(() => launcher.current?.focus());
  }, []);

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      event.stopPropagation();
      close();
    }
  }

  return (
    <div className="print:hidden">
      <section
        id={windowId}
        role="dialog"
        aria-modal="false"
        aria-labelledby={titleId}
        aria-describedby={aboutId}
        hidden={!open}
        onKeyDown={onKeyDown}
        data-testid="assistant-window"
        className={clsx(
          "fixed z-40 flex-col overflow-hidden rounded-sheet border border-rule bg-paper text-fg shadow-float",
          open ? "flex" : "hidden",
          // Phones: the width of the screen less 8px a side, above the launcher.
          "inset-x-2 bottom-[70px] h-[min(560px,calc(100dvh-140px))]",
          // From 640px: a 380px window over the corner, clear of the header.
          "sm:inset-x-auto sm:right-6 sm:bottom-[80px] sm:w-[380px] sm:h-[min(580px,calc(100dvh-184px))]",
          "origin-bottom-right animate-[hb-rise_140ms_ease-out] motion-reduce:animate-none",
        )}
      >
        <header className="flex shrink-0 items-start gap-3 border-b border-rule px-4 pb-3 pt-3.5">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} ref={heading} tabIndex={-1} className="text-h3 font-bold leading-tight text-fg outline-none">
              Ask a question
            </h2>
            <p id={aboutId} className="mt-1 text-meta text-fg-3">
              Answered from the {brand} documentation, with the pages used. It cannot see this workspace.
            </p>
          </div>
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            data-testid="assistant-close"
            className="-mr-1.5 -mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full text-fg-3 transition-colors duration-150 hover:bg-paper-3 hover:text-fg"
          >
            <Close size={14} />
          </button>
        </header>

        {load.state === "ready" ? (
          <Conversation organizationId={organizationId} intro={load.intro} open={open} />
        ) : load.state === "refused" ? (
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
            <ActionRefusal error={load.error} />
            <p className="text-ui text-fg-2">
              The <Link href="/faq" className="link">FAQ</Link> and the <Link href="/guide" className="link">setup guide</Link>{" "}
              answer most questions on every plan, and{" "}
              <Link href={FALLBACK_SUPPORT.url} className="link">
                support
              </Link>{" "}
              answers the rest.
            </p>
          </div>
        ) : load.state === "failed" ? (
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
            <Notice
              tone="fail"
              title="Questions could not be opened"
              action={
                <Button size="sm" onClick={() => setLoad({ state: "idle" })}>
                  Try again
                </Button>
              }
            >
              {load.message} Nothing was asked yet. Support can still help.
            </Notice>
            <SupportLine support={FALLBACK_SUPPORT} />
          </div>
        ) : (
          <div role="status" className="flex flex-1 items-center justify-center">
            <span className="sr-only">Opening</span>
            <TideMark size={40} />
          </div>
        )}
      </section>

      <button
        ref={launcher}
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
        aria-expanded={open}
        aria-controls={windowId}
        aria-label={open ? "Close questions" : `Ask a question about ${brand}`}
        data-testid="assistant-open"
        className={clsx(
          "fixed bottom-4 right-4 z-40 inline-flex h-11 items-center gap-2 rounded-full pl-3.5 pr-4 text-ui font-semibold",
          "sm:bottom-6 sm:right-6",
          "bg-fg text-paper transition-colors duration-150 hover:bg-fg-2",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-act",
        )}
      >
        {open ? <Close size={14} className="mx-0.5 shrink-0" /> : <AskMark />}
        <span aria-hidden>{open ? "Close" : "Ask"}</span>
      </button>
    </div>
  );
}

function Conversation({ organizationId, intro, open }: { organizationId: string; intro: AssistantIntro; open: boolean }) {
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<{ tone: "warn" | "fail"; text: string } | null>(null);
  const [planError, setPlanError] = useState<ActionError | null>(null);
  const input = useRef<HTMLInputElement | null>(null);
  const latest = useRef<HTMLElement | null>(null);
  const nextId = useRef(1);
  const inputId = useId();
  const hintId = useId();
  const max = intro.maxQuestionChars;

  // Each time the window opens, the question field takes focus.
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => input.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    latest.current?.scrollIntoView({ block: "start" });
  }, [exchanges.length]);

  const ask = useCallback(
    async (text: string) => {
      const question = text.trim();
      if (!question || pending) return;
      if (question.length > max) {
        setProblem({ tone: "warn", text: `A question can be at most ${max} characters. Ask about one thing at a time.` });
        return;
      }
      setProblem(null);
      setPlanError(null);
      setPending(true);
      const id = nextId.current++;
      setExchanges((list) => [...list, { id, question, reply: null }].slice(-KEEP));
      setDraft("");

      const r = await askAssistant(organizationId, question);
      setPending(false);
      if (r.ok) {
        setExchanges((list) => list.map((e) => (e.id === id ? { ...e, reply: r.data } : e)));
      } else {
        // Not answered at all: the question comes back to the field, and the
        // reason is said under it. A failed request is never shown as an answer.
        setExchanges((list) => list.filter((e) => e.id !== id));
        setDraft(question);
        if (isPlanRefusal(r.error)) setPlanError(r.error);
        else setProblem({ tone: r.status === 429 || r.status === 400 ? "warn" : "fail", text: r.error.message ?? "The question could not be sent." });
      }
      requestAnimationFrame(() => input.current?.focus());
    },
    [organizationId, pending, max],
  );

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void ask(draft);
  }

  const support = exchanges.findLast((e) => e.reply)?.reply?.support ?? intro.support ?? FALLBACK_SUPPORT;
  const remaining = max - draft.length;

  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4">
        {intro.mode === "links" ? (
          <p className="mb-4 text-meta text-fg-3" data-testid="assistant-links-mode">
            Written answers are not switched on here, so a question returns the documentation pages that match it.
          </p>
        ) : null}

        {planError ? <ActionRefusal error={planError} className="mb-4" /> : null}

        <div role="log" aria-live="polite" aria-busy={pending} aria-label="Answers" data-testid="assistant-log">
          {exchanges.map((exchange, index) => (
            <ExchangeView
              key={exchange.id}
              exchange={exchange}
              refEl={index === exchanges.length - 1 ? latest : undefined}
              onAsk={(q) => void ask(q)}
              disabled={pending}
            />
          ))}
        </div>

        {exchanges.length === 0 ? <Starters groups={intro.starters} onAsk={(q) => void ask(q)} disabled={pending} /> : null}
      </div>

      <form onSubmit={onSubmit} className="shrink-0 border-t border-rule px-4 pb-3 pt-3" noValidate>
        <label htmlFor={inputId} className="sr-only">
          Your question
        </label>
        <div className="flex items-center gap-2">
          <Input
            id={inputId}
            ref={input}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={max + 50}
            placeholder="How do I…"
            autoComplete="off"
            enterKeyHint="send"
            aria-describedby={hintId}
            aria-invalid={remaining < 0 || undefined}
            data-testid="assistant-input"
            className="min-w-0 flex-1"
          />
          <Button
            type="submit"
            variant="primary"
            busy={pending}
            busyLabel="Looking through the documentation"
            disabled={!draft.trim()}
            data-testid="assistant-ask"
          >
            Ask
          </Button>
        </div>
        {problem ? (
          <p role="alert" className={clsx("mt-2 text-meta font-medium", problem.tone === "fail" ? "text-fail" : "text-warn")}>
            {problem.text}
          </p>
        ) : null}
        <p id={hintId} className="mt-2 text-meta text-fg-3">
          {remaining < 80 ? (
            <span className={clsx("tnum", remaining < 0 && "font-semibold text-warn")}>
              {remaining < 0 ? `${-remaining} over the limit. ` : `${remaining} characters left. `}
            </span>
          ) : null}
          Email addresses, domains and IP addresses are removed before a question is sent.
        </p>
        <SupportLine support={support} className="mt-1" />
      </form>
    </>
  );
}

function Starters({
  groups,
  onAsk,
  disabled,
}: {
  groups: AssistantIntro["starters"];
  onAsk: (question: string) => void;
  disabled: boolean;
}) {
  return (
    <section aria-label="Suggested questions" data-testid="assistant-starters">
      <p className="text-ui text-fg-2">Ask in your own words, or start from one of these.</p>
      <div className="mt-3 flex flex-col gap-4">
        {groups.map((group) => (
          <div key={group.task}>
            <p className="text-meta font-bold text-fg">{group.task}</p>
            <ul className="mt-1 flex flex-col">
              {group.questions.map((question) => (
                <li key={question}>
                  <QuestionButton question={question} onAsk={onAsk} disabled={disabled} />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

/** A suggested question: a line of text that takes a quiet fill on hover. */
function QuestionButton({ question, onAsk, disabled }: { question: string; onAsk: (q: string) => void; disabled: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onAsk(question)}
      className="-mx-2 w-[calc(100%+16px)] rounded-lg px-2 py-1 text-left text-ui text-fg-2 transition-colors duration-150 hover:bg-paper-3 hover:text-fg disabled:cursor-not-allowed disabled:text-fg-4"
    >
      {question}
    </button>
  );
}

function ExchangeView({
  exchange,
  refEl,
  onAsk,
  disabled,
}: {
  exchange: Exchange;
  refEl?: RefObject<HTMLElement | null>;
  onAsk: (question: string) => void;
  disabled: boolean;
}) {
  const { question, reply } = exchange;
  return (
    <article
      ref={refEl}
      data-testid="assistant-exchange"
      data-outcome={reply?.outcome ?? "pending"}
      className="scroll-mt-2 border-b border-rule py-4 first:pt-0 last:border-b-0"
    >
      <p className="text-ui font-semibold text-fg [overflow-wrap:anywhere]">{question}</p>
      {reply ? (
        <ReplyView reply={reply} onAsk={onAsk} disabled={disabled} />
      ) : (
        <div className="mt-3 flex items-center gap-3">
          <TideMark size={22} />
          <span className="text-meta text-fg-3">Looking through the documentation</span>
        </div>
      )}
    </article>
  );
}

/** "I don't know. The rest…" → the plain admission set as firmly as an answer. */
function splitAdmission(message: string): [string | null, string] {
  const m = /^(I don't know\.)\s*(.*)$/s.exec(message);
  return m ? [m[1]!, m[2]!] : [null, message];
}

function ReplyView({ reply, onAsk, disabled }: { reply: AssistantReply; onAsk: (q: string) => void; disabled: boolean }) {
  const unanswered = reply.outcome === "unknown" || reply.outcome === "refused";
  const [admission, rest] = splitAdmission(reply.message ?? "");
  // Links-only because written answers are off: the note at the top already
  // says so, and the sources' own label says what they are.
  const quietLinks = reply.outcome === "links_only" && reply.reason === "not_enabled";

  return (
    <div className="mt-2">
      {reply.outcome === "answered" && reply.answer ? (
        <p className="whitespace-pre-line text-body leading-[1.55] text-fg-2" data-testid="assistant-answer">
          {reply.answer}
        </p>
      ) : reply.outcome === "links_only" ? (
        quietLinks ? null : <p className="text-ui text-fg-3">{reply.message}</p>
      ) : (
        <p className="text-body leading-[1.55] text-fg-2" data-testid="assistant-unanswered">
          {admission ? <strong className="font-semibold text-fg">{admission} </strong> : null}
          {rest}
        </p>
      )}

      {unanswered ? <SupportLine support={reply.support} className="mt-2" compact /> : null}

      {reply.sources.length > 0 ? (
        <div className={quietLinks ? "mt-1" : "mt-3"}>
          <p className="legend">{reply.sourcesLabel ?? "Sources"}</p>
          <ul className="mt-1.5 flex flex-col gap-1">
            {reply.sources.map((source) => (
              <SourceLink key={source.id} source={source} />
            ))}
          </ul>
        </div>
      ) : null}

      {reply.followUps.length > 0 ? (
        <div className="mt-3">
          <p className="legend">Ask next</p>
          <ul className="mt-1 flex flex-col">
            {reply.followUps.map((question) => (
              <li key={question}>
                <QuestionButton question={question} onAsk={onAsk} disabled={disabled} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/** A source as the map labels a station: the page in bold, the section lighter beside it. */
function SourceLink({ source }: { source: AssistantSource }) {
  return (
    <li>
      <a
        href={source.url}
        target="_blank"
        rel="noopener"
        data-testid="assistant-source"
        className="group inline-flex max-w-full items-baseline gap-1.5 rounded text-ui hover:text-fg"
      >
        <span className="shrink-0 font-semibold text-fg group-hover:underline">{source.page}</span>
        {source.section ? <span className="min-w-0 truncate text-fg-3">{source.section}</span> : null}
        <External size={12} className="shrink-0 self-center text-fg-4" />
        <span className="sr-only">(opens in a new tab)</span>
      </a>
    </li>
  );
}

function SupportLine({
  support,
  className,
  compact,
}: {
  support: { url: string; email: string };
  className?: string;
  compact?: boolean;
}) {
  return (
    <p className={clsx("text-meta text-fg-3", className)} data-testid={compact ? undefined : "assistant-support"}>
      {compact ? null : "Not answered? "}
      <Link href={support.url} className="link font-semibold">
        Ask support
      </Link>{" "}
      or write to{" "}
      <a href={`mailto:${support.email}`} className="link [overflow-wrap:anywhere]">
        {support.email}
      </a>
      .
    </p>
  );
}

/**
 * The launcher's mark: a question mark drawn as a line on the map. The hook
 * is a line that bends at 45° and drops to a stop, and the dot is a station,
 * hollow so the pill's ink shows through it.
 */
function AskMark() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
      className="shrink-0"
    >
      <path d="M6.6 6.4a3.4 3.4 0 1 1 5.8 2.4L10 11.2v.3" strokeWidth={2.2} />
      <circle cx="10" cy="15.7" r="1.55" strokeWidth={1.8} />
    </svg>
  );
}
