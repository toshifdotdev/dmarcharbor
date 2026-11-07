"use client";

/**
 * dmarc-tool.tsx — /tools/dmarc: read a domain's DMARC record, tag by tag.
 *
 * At rest it shows the record example.com really publishes (RFC 2606
 * reserved), labelled as the example, so the page is never empty. After a
 * lookup everything shown is what POST /api/scan returned: the record as
 * published, its tags, where reports go, and the scanner's own findings.
 *
 * Every tag that matters is a station on one line: open when the record sets
 * it, closed when it does not, with the default the standard applies (RFC
 * 9989). The meanings come from the home page's check (record-reading.tsx
 * TAGS), so the two never disagree.
 *
 * Test hooks: tool-dmarc-input, tool-dmarc-submit, tool-dmarc (data-state),
 * tool-policy-line, tool-findings.
 */

import { useState } from "react";
import { clsx } from "clsx";
import { CopyButton } from "@/components/ui/copy";
import { TAGS, parseTags, type Tone } from "../record-reading";
import { Breakable, Findings, PolicyLine, StationList, issuesFor } from "./figures";
import { FigureHead, LookupLine, LookupStatus } from "./lookup-line";
import { lookupDomain, useScan, type ToolScan } from "./scan";

const EXAMPLE_RECORD = "v=DMARC1;p=reject;sp=reject;adkim=s;aspf=s";

const TONE_TEXT: Record<Tone, string> = {
  ok: "text-ok",
  warn: "text-warn",
  fail: "text-fail",
  void: "text-fg-4",
  plain: "text-fg-2",
};

interface Shown {
  domain: string;
  example: boolean;
  record: string | null;
  status: "found" | "missing" | "error";
  tags: Record<string, string>;
  policy: string | null;
  testing: boolean;
  effective: string | null;
  delegatedTo: string | null;
  mailto: string[];
  web: string[];
  scan: ToolScan | null;
}

function shownFrom(scan: ToolScan): Shown {
  const tags =
    scan.dmarc.tags && Object.keys(scan.dmarc.tags).length
      ? Object.fromEntries(Object.entries(scan.dmarc.tags).map(([k, v]) => [k.toLowerCase(), v]))
      : parseTags(scan.dmarc.record);
  return {
    domain: scan.domain,
    example: false,
    record: scan.dmarc.record ?? null,
    status: scan.dmarc.status,
    tags,
    policy: scan.dmarc.status === "found" ? scan.dmarc.policy : null,
    testing: Boolean(scan.dmarc.testing),
    effective: scan.dmarc.effectivePolicy ?? null,
    delegatedTo: scan.dmarc.delegatedTo ?? null,
    mailto: scan.dmarc.aggregateMailtoTargets ?? [],
    web: scan.dmarc.aggregateWebTargets ?? [],
    scan,
  };
}

const EXAMPLE: Shown = {
  domain: "example.com",
  example: true,
  record: EXAMPLE_RECORD,
  status: "found",
  tags: parseTags(EXAMPLE_RECORD),
  policy: "reject",
  testing: false,
  effective: "reject",
  delegatedTo: null,
  mailto: [],
  web: [],
  scan: null,
};

export function DmarcTool() {
  const [domain, setDomain] = useState("");
  const { state, run, reset } = useScan();
  const busy = state.phase === "busy";
  const shown = state.phase === "done" ? shownFrom(state.result) : EXAMPLE;

  function submit() {
    const wanted = lookupDomain(domain);
    if (!wanted) return;
    setDomain(wanted);
    void run(wanted);
  }

  return (
    <section data-testid="tool-dmarc" data-state={state.phase} aria-label="DMARC record lookup">
      <LookupLine
        id="tool-dmarc"
        prefix={<>TXT&nbsp;_dmarc.</>}
        value={domain}
        onChange={setDomain}
        onSubmit={submit}
        busy={busy}
        submitLabel="Read the record"
        busyLabel="Reading DNS"
      />
      <LookupStatus
        state={state}
        idle={
          <>
            Showing the record <span className="data text-fg-2">example.com</span> really publishes. Type any domain to read
            its own.
          </>
        }
        read={
          <>
            Read <span className="data text-fg-2">_dmarc.{shown.domain}</span> from public DNS just now. Nothing is stored
            about the domain.{" "}
            <button
              type="button"
              className="font-semibold text-fg underline decoration-rule-2 underline-offset-[3px] hover:decoration-fg"
              onClick={() => {
                reset();
                setDomain("");
              }}
            >
              Back to the example
            </button>
          </>
        }
      />

      <div
        aria-busy={busy || undefined}
        className={clsx(
          "mt-6 grid gap-x-16 gap-y-14 transition-opacity duration-150 min-[68.75rem]:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)]",
          busy && "opacity-35",
        )}
      >
        <div className="flex min-w-0 flex-col gap-12">
          <figure className="m-0">
            <FigureHead
              name={shown.example ? "Example record" : "The record"}
              meta={<span className="data">_dmarc.{shown.domain}</span>}
            />
            <div className="mt-4 flex items-start gap-3">
              <p
                data-missing={shown.record ? undefined : ""}
                className={clsx(
                  "data min-w-0 flex-1 [overflow-wrap:anywhere] font-semibold tracking-[-0.02em]",
                  (shown.record?.length ?? 0) > 90 ? "text-[16px] leading-[1.45]" : "text-[17px] leading-[1.4] sm:text-[22px]",
                  shown.record ? "text-fg" : "text-fail",
                )}
              >
                {(shown.record ? <Breakable text={shown.record} /> : null) ??
                  (shown.status === "missing"
                    ? `No record at _dmarc.${shown.domain}`
                    : "The lookup could not read the record. Nothing was measured.")}
              </p>
              {shown.record ? <CopyButton value={shown.record} label="Copy the DMARC record" /> : null}
            </div>
            {shown.delegatedTo ? (
              <p className="mt-2 text-[14px] text-fg-4">
                Published through a CNAME to <span className="data text-fg-2">{shown.delegatedTo}</span>: whoever runs that
                name controls this policy.
              </p>
            ) : null}
            {shown.example ? <figcaption className="mt-3 text-[14px] text-fg-4">Sample: example.com is reserved for examples and sends no mail.</figcaption> : null}
          </figure>

          <div>
            <FigureHead name="Policy" meta="what receivers do with mail that fails" className="mb-6" />
            <PolicyLine
              policy={shown.policy}
              note={
                shown.policy === null
                  ? "With no record, receivers apply no policy and send no reports."
                  : shown.testing
                    ? `Testing mode (t=y) is on, so receivers treat failing mail one step softer: as p=${shown.effective ?? "none"}.`
                    : shown.policy === "none"
                      ? "Watch only. The next step, once every sender passes, is p=quarantine."
                      : shown.policy === "quarantine"
                        ? "Failing mail goes to spam. The last step is p=reject."
                        : "The strongest policy: mail that fails is refused."
              }
            />
          </div>

          {shown.example ? null : (
            <div>
              <FigureHead name="Reports" meta="where receivers send what they saw" className="mb-4" />
              {shown.mailto.length === 0 && shown.web.length === 0 ? (
                <p className="text-[15px] text-warn">
                  <span className="font-semibold">No rua address.</span>{" "}
                  <span className="text-fg-2">Nobody receives this domain&rsquo;s reports, so nobody can see who sends as it.</span>
                </p>
              ) : (
                <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
                  {shown.mailto.map((address) => (
                    <li key={address} className="data break-all text-[14.5px] text-fg">
                      {address}
                    </li>
                  ))}
                  {shown.web.map((address) => (
                    <li key={address} className="text-[14.5px] text-fg-2">
                      <span className="data break-all text-fg">{address}</span>{" "}
                      <span className="text-warn">(a web address: most receivers send reports only by mail)</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {shown.scan ? (
            <div>
              <FigureHead name="Findings" meta="from the scanner" className="mb-4" />
              <Findings
                issues={issuesFor("dmarc_", shown.scan.dmarc.notices, shown.scan.issues)}
                none="The scanner raised nothing about this record."
              />
            </div>
          ) : null}
        </div>

        <div className="min-w-0">
          <FigureHead name="Tag by tag" meta="open: set in the record; closed: the default applies" className="mb-6" />
          <StationList
            label={`What ${shown.domain}'s record makes receivers do`}
            items={TAGS.map(({ tag, label, present, absent }) => {
              const value = shown.tags[tag];
              const has = value !== undefined && value !== "";
              const [meaning, tone] = !shown.record
                ? (["No record, so nothing applies.", "void"] as [string, Tone])
                : has
                  ? present(value)
                  : typeof absent === "function"
                    ? absent(shown.tags)
                    : absent;
              return {
                key: tag,
                state: has ? "open" : "closed",
                name: label,
                meta: <span className="data">{has ? `${tag}=${value}` : `${tag} not set`}</span>,
                children: <span className={TONE_TEXT[tone]}>{meaning}</span>,
              };
            })}
          />
        </div>
      </div>
    </section>
  );
}
