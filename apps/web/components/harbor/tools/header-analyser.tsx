"use client";

/**
 * header-analyser.tsx — /tools/email-header-analyser: paste a message's
 * headers and read how it was checked and where it went.
 *
 * Read in the browser (lib/email-headers.ts) and never uploaded. At rest it
 * reads a sample, labelled as one.
 *
 * Two drawings:
 *   the checks   SPF, DKIM and DMARC as stations on one line to the inbox:
 *                green where the receiver says it passed, a red bar where it
 *                failed, closed and grey where there was no result; under
 *                each, whether the domain it passed for aligns with From;
 *   the route    every server the message passed through, oldest first, as
 *                stations on a line, with the time each hop took.
 *
 * Test hooks: header-input, header-read, header-analyser (data-state),
 * header-checks (data-dmarc), header-route, header-fields.
 */

import { useMemo, useState } from "react";
import { clsx } from "clsx";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/choice";
import { KeyValue } from "@/components/ui/notice";
import { HeaderReadError, SAMPLE_HEADERS, readHeaders, type CheckResult, type HeaderReading } from "@/lib/email-headers";
import { StateWord } from "../ops-parts";
import { StationList, type StationItem } from "./figures";
import { FigureHead } from "./lookup-line";

function delayLabel(seconds: number | null): string | null {
  if (seconds === null) return null;
  if (seconds < 0) return "clock differs between the servers";
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  return `${(seconds / 3600).toFixed(1)} h`;
}

function stationFor(result: CheckResult["result"] | undefined): StationItem["state"] {
  if (result === "pass") return "passed";
  if (result === "fail" || result === "softfail" || result === "permerror") return "failed";
  return "closed";
}

function alignWord(value: boolean | null): string {
  return value === null ? "no result to align" : value ? "aligned with the From domain" : "not aligned with the From domain";
}

export function HeaderAnalyser() {
  const [raw, setRaw] = useState("");
  const [reading, setReading] = useState<HeaderReading | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sample = useMemo(() => readHeaders(SAMPLE_HEADERS), []);
  const shown = reading ?? sample;

  function read() {
    setError(null);
    try {
      setReading(readHeaders(raw));
    } catch (e) {
      setError(e instanceof HeaderReadError ? e.message : "Those headers could not be read.");
    }
  }

  const spf = shown.checks.find((c) => c.method === "spf");
  const dkims = shown.checks.filter((c) => c.method === "dkim");
  const dkimPass = dkims.find((c) => c.result === "pass");
  const dmarc = shown.checks.find((c) => c.method === "dmarc");
  const arc = shown.checks.find((c) => c.method === "arc");
  const dmarcVerdict = dmarc?.result ?? (shown.computed.dmarc === "unknown" ? undefined : shown.computed.dmarc);

  const checkItems: StationItem[] = [
    {
      key: "spf",
      state: stationFor(spf?.result),
      name: "SPF",
      meta: spf ? `${spf.result}${spf.domain ? ` for ${spf.domain}` : ""}` : "no result in the headers",
      children: <span className={shown.computed.spfAligned ? "text-ok" : "text-fg-2"}>{alignWord(shown.computed.spfAligned)}</span>,
    },
    {
      key: "dkim",
      state: stationFor(dkimPass?.result ?? dkims[0]?.result),
      name: "DKIM",
      meta: dkims.length
        ? dkims.map((d) => `${d.result}${d.domain ? ` for ${d.domain}` : ""}${d.selector ? ` (${d.selector})` : ""}`).join(", ")
        : shown.signatures.length
          ? `signed by ${shown.signatures.map((s) => s.domain).join(", ")}, no receiver result`
          : "not signed",
      children: <span className={shown.computed.dkimAligned ? "text-ok" : "text-fg-2"}>{alignWord(shown.computed.dkimAligned)}</span>,
    },
    {
      key: "dmarc",
      state: stationFor(dmarcVerdict as CheckResult["result"] | undefined),
      name: "DMARC",
      meta: dmarc ? `${dmarc.result}${dmarc.domain ? ` for ${dmarc.domain}` : ""}, as the receiver says` : "no receiver result",
      children: (
        <span className="text-fg-2">
          From the checks above it {shown.computed.dmarc === "pass" ? "passes" : shown.computed.dmarc === "fail" ? "fails" : "cannot be worked out"}:{" "}
          {shown.computed.dmarc === "pass" ? "one aligned pass is enough." : shown.computed.dmarc === "fail" ? "neither SPF nor DKIM passed for the From domain." : "no SPF or DKIM result."}
          {arc ? ` ARC: ${arc.result}.` : ""}
        </span>
      ),
    },
  ];

  const hopItems: StationItem[] = shown.hops.map((hop, i) => ({
    key: `hop-${i}`,
    state: "open",
    name: <span className="data">{hop.by ?? "unnamed server"}</span>,
    meta: (
      <>
        {hop.from ? <>from <span className="data">{hop.from}</span></> : "first hop"}
        {hop.with ? ` · ${hop.with}` : ""}
      </>
    ),
    children: (
      <span className={clsx(hop.delaySeconds !== null && hop.delaySeconds > 300 ? "font-semibold text-warn" : "text-fg-3")}>
        {hop.at ? hop.at.toISOString().replace("T", " ").slice(0, 19) + " UTC" : "no time given"}
        {delayLabel(hop.delaySeconds) ? ` · +${delayLabel(hop.delaySeconds)}` : ""}
        {hop.delaySeconds !== null && hop.delaySeconds > 300 ? " · a slow hop" : ""}
      </span>
    ),
  }));

  return (
    <section data-testid="header-analyser" data-state={reading ? "read" : "sample"} aria-label="Email header analyser">
      <div className="flex flex-col gap-3">
        <label htmlFor="header-input" className="text-[14px] font-semibold text-fg">
          The message headers
        </label>
        <Textarea
          id="header-input"
          mono
          rows={9}
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          placeholder={"Received: from …\nAuthentication-Results: …\nFrom: …"}
          spellCheck={false}
          data-testid="header-input"
        />
        <p className="text-[13.5px] leading-[1.45] text-fg-4">
          In Outlook: File › Properties › Internet headers. In Gmail: ⋮ › Show original. Read in this browser and never
          uploaded.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" size="lg" onClick={read} disabled={!raw.trim()} data-testid="header-read">
            Read the headers
          </Button>
          {reading ? (
            <button
              type="button"
              className="text-[14px] font-semibold text-fg underline decoration-rule-2 underline-offset-[3px] hover:decoration-fg"
              onClick={() => {
                setReading(null);
                setRaw("");
              }}
            >
              Back to the sample
            </button>
          ) : null}
        </div>
        <div aria-live="polite" className="min-h-[22px] text-[13.5px]">
          {error ? (
            <p role="alert" className="font-semibold text-fail">
              {error}
            </p>
          ) : reading ? (
            <p className="text-fg-4">Read {shown.headerCount} header lines.</p>
          ) : (
            <p className="text-fg-4">Showing a sample message. Paste one of your own to read it.</p>
          )}
        </div>
      </div>

      <div className="mt-8 grid gap-x-16 gap-y-14 min-[68.75rem]:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-12">
          <div data-testid="header-checks" data-dmarc={shown.computed.dmarc}>
            <FigureHead
              name="How it was checked"
              meta={shown.authServer ? <>by <span className="data">{shown.authServer}</span></> : reading ? "no Authentication-Results header" : "sample data"}
              className="mb-6"
            />
            <StationList label="SPF, DKIM and DMARC for this message" items={checkItems} />
            <div className="mt-6 border-t border-rule pt-4">
              {shown.computed.dmarc === "pass" ? (
                <StateWord shape="square" tone="ok" className="text-[16px]! whitespace-normal">
                  Passes DMARC for {shown.fromDomain ?? "the From domain"}
                </StateWord>
              ) : shown.computed.dmarc === "fail" ? (
                <StateWord shape="diamond" tone="fail" className="text-[16px]! whitespace-normal">
                  Fails DMARC for {shown.fromDomain ?? "the From domain"}
                </StateWord>
              ) : (
                <StateWord shape="ring" tone="void" className="text-[16px]! whitespace-normal">
                  DMARC cannot be worked out from these headers
                </StateWord>
              )}
              <p className="mt-2 text-[13.5px] leading-[1.5] text-fg-4">
                Alignment compares organisational domains, estimated here from the last two labels (three under suffixes such as
                co.uk).
              </p>
            </div>
          </div>

          <div data-testid="header-fields">
            <FigureHead name="The envelope" meta="who it says it is from, and where bounces go" className="mb-4" />
            <KeyValue
              labelWidth={130}
              rows={[
                ["From", <span key="f" className="data [overflow-wrap:anywhere]">{shown.from ?? "not given"}</span>],
                ["Return-Path", <span key="r" className="data [overflow-wrap:anywhere]">{shown.returnPath ?? "not given"}</span>],
                [
                  "DKIM signed by",
                  <span key="d" className="data [overflow-wrap:anywhere]">
                    {shown.signatures.length ? shown.signatures.map((s) => `${s.domain}${s.selector ? ` (s=${s.selector})` : ""}`).join(", ") : "not signed"}
                  </span>,
                ],
                shown.subject ? ["Subject", shown.subject] : null,
                shown.date ? ["Date", shown.date] : null,
                shown.messageId ? ["Message-ID", <span key="m" className="data [overflow-wrap:anywhere]">{shown.messageId}</span>] : null,
              ]}
            />
          </div>
        </div>

        <div className="min-w-0" data-testid="header-route">
          <FigureHead name="Where it went" meta={`${shown.hops.length} hop${shown.hops.length === 1 ? "" : "s"}, oldest first`} className="mb-6" />
          {hopItems.length ? (
            <StationList label="The servers the message passed through" items={hopItems} />
          ) : (
            <p className="text-[15px] text-fg-2">No Received headers, so the route cannot be drawn.</p>
          )}
          <p className="mt-6 max-w-[42ch] text-[13.5px] leading-[1.5] text-fg-4">
            Each server adds its Received line at the top, so the route is read from the bottom up. Times come from each
            server&rsquo;s own clock.
          </p>
        </div>
      </div>
    </section>
  );
}
