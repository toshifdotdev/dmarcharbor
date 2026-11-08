"use client";

/**
 * spf-tool.tsx — /tools/spf: a domain's SPF record, with its DNS lookups
 * counted the way receivers count them (RFC 7208 section 4.6.4), through
 * every include and redirect.
 *
 * Two drawings:
 *   the count   ten stations, one per lookup the standard allows. Lookups
 *               used are ink, the rest a grey dashed line ahead; past ten the
 *               line runs on dashed red to a red bar, because SPF then fails
 *               at every receiver however well formed the record is.
 *   the tree    the record as a map: the domain's own terms are stations on
 *               an ink trunk, and each include that pulls in more is its
 *               service's own coloured line (one colour, one service), with
 *               the lookups each term costs beside it.
 *
 * Everything shown after a lookup is what POST /api/scan returned. At rest the
 * page shows a sample record, labelled as one.
 *
 * Test hooks: tool-spf-input, tool-spf-submit, tool-spf (data-state),
 * tool-spf-count (data-count), tool-spf-tree, tool-findings.
 */

import { useState } from "react";
import { clsx } from "clsx";
import { CopyButton } from "@/components/ui/copy";
import { StateWord } from "../ops-parts";
import { Breakable, Findings, issuesFor } from "./figures";
import { FigureHead, LookupLine, LookupStatus } from "./lookup-line";
import { lookupDomain, useScan, type SpfNode, type ToolScan } from "./scan";

const LIMIT = 10;
/** A term in the tree wraps after a dot or colon, never inside a label (session 18, 390 px). */
const NAME_BREAKS = /(?<=[.:])/;
const VOID_LIMIT = 2;

/** One colour per service line, never red (red is the forged sender). */
const LINE = [
  { bg: "bg-route-blue", border: "border-route-blue" },
  { bg: "bg-route-orange", border: "border-route-orange" },
  { bg: "bg-route-green", border: "border-route-green" },
  { bg: "bg-route-purple", border: "border-route-purple" },
  { bg: "bg-route-yellow", border: "border-route-yellow" },
] as const;

interface Shown {
  domain: string;
  example: boolean;
  status: "found" | "missing" | "error";
  record: string | null;
  valid: boolean;
  count: number;
  voids: number;
  complete: boolean;
  tree: SpfNode[];
  problems: string[];
  scan: ToolScan | null;
}

/**
 * A sample: a small practice on Microsoft 365 that sends appointment reminders
 * through Mailgun. The includes are as Microsoft and Mailgun published them in
 * October 2026 (read from DNS when this was written).
 */
const EXAMPLE: Shown = {
  domain: "pellowyn-dental.example",
  example: true,
  status: "found",
  record: "v=spf1 include:spf.protection.outlook.com include:mailgun.org mx -all",
  valid: true,
  count: 7,
  voids: 0,
  complete: true,
  tree: [
    { term: "include:spf.protection.outlook.com", lookups: 1 },
    {
      term: "include:mailgun.org",
      lookups: 5,
      children: [
        {
          term: "include:_spf.mailgun.org",
          lookups: 3,
          children: [
            { term: "include:_spf1.mailgun.org", lookups: 1 },
            { term: "include:_spf2.mailgun.org", lookups: 1 },
          ],
        },
        { term: "include:_spf.eu.mailgun.org", lookups: 1 },
      ],
    },
    { term: "mx", lookups: 1 },
  ],
  problems: [],
  scan: null,
};

function shownFrom(scan: ToolScan): Shown {
  return {
    domain: scan.domain,
    example: false,
    status: scan.spf.status,
    record: scan.spf.record ?? null,
    valid: scan.spf.valid,
    count: scan.spf.lookupCount ?? 0,
    voids: scan.spf.voidLookupCount ?? 0,
    complete: scan.spf.lookupsComplete !== false,
    tree: scan.spf.lookupTree ?? [],
    problems: scan.spf.problems ?? [],
    scan,
  };
}

export function SpfTool() {
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

  const over = shown.count > LIMIT;
  const verdict = !shown.record
    ? null
    : !shown.valid
      ? { tone: "fail" as const, shape: "diamond" as const, word: "Invalid record: SPF fails" }
      : over
        ? { tone: "fail" as const, shape: "diamond" as const, word: "Over the limit: SPF fails at every receiver" }
        : shown.voids > VOID_LIMIT
          ? { tone: "fail" as const, shape: "diamond" as const, word: "Too many lookups find nothing: receivers may fail SPF" }
          : shown.count >= LIMIT - 1
            ? { tone: "warn" as const, shape: "ring" as const, word: "Near the limit: one more include breaks SPF" }
            : { tone: "ok" as const, shape: "square" as const, word: "Within the limit" };

  return (
    <section data-testid="tool-spf" data-state={state.phase} aria-label="SPF record lookup">
      <LookupLine
        id="tool-spf"
        prefix={<>TXT&nbsp;</>}
        value={domain}
        onChange={setDomain}
        onSubmit={submit}
        busy={busy}
        submitLabel="Count the lookups"
        busyLabel="Following every include"
      />
      <LookupStatus
        state={state}
        idle="Showing a sample record. Type any domain to read its own and follow every include."
        read={
          <>
            Read <span className="data text-fg-2">{shown.domain}</span> and every include from public DNS just now.{" "}
            <button
              type="button"
              className="font-semibold text-fg underline decoration-rule-2 underline-offset-[3px] hover:decoration-fg"
              onClick={() => {
                reset();
                setDomain("");
              }}
            >
              Back to the sample
            </button>
          </>
        }
      />

      <div
        aria-busy={busy || undefined}
        className={clsx(
          "mt-6 grid gap-x-16 gap-y-14 transition-opacity duration-150 min-[68.75rem]:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]",
          busy && "opacity-35",
        )}
      >
        <div className="flex min-w-0 flex-col gap-12">
          <figure className="m-0">
            <FigureHead name={shown.example ? "Sample record" : "The record"} meta={<span className="data">{shown.domain}</span>} />
            <div className="mt-4 flex items-start gap-3">
              <p
                className={clsx(
                  "data min-w-0 flex-1 [overflow-wrap:anywhere] font-semibold tracking-[-0.02em]",
                  (shown.record?.length ?? 0) > 90 ? "text-[15.5px] leading-[1.5]" : "text-[16px] leading-[1.45] sm:text-[20px]",
                  shown.record ? "text-fg" : "text-fail",
                )}
              >
                {(shown.record ? <Breakable text={shown.record} /> : null) ??
                  (shown.status === "missing"
                    ? `No SPF record at ${shown.domain}`
                    : "The lookup could not read the record. Nothing was measured.")}
              </p>
              {shown.record ? <CopyButton value={shown.record} label="Copy the SPF record" /> : null}
            </div>
            {shown.example ? (
              <figcaption className="mt-3 text-[14px] text-fg-4">Sample data: a practice on Microsoft 365 that sends reminders through Mailgun. The includes are as both services published them in October 2026.</figcaption>
            ) : null}
          </figure>

          {shown.record ? (
            <div>
              <FigureHead name="DNS lookups" meta="counted through every include, against the limit of 10" className="mb-6" />
              <LookupCount count={shown.count} />
              <div className="mt-5 flex flex-col gap-2">
                {verdict ? (
                  <StateWord shape={verdict.shape} tone={verdict.tone} className="text-[15px]! whitespace-normal">
                    {verdict.word}
                  </StateWord>
                ) : null}
                <p className="text-[14.5px] leading-[1.5] text-fg-2">
                  <span className="tnum font-semibold text-fg">{shown.voids}</span> of {VOID_LIMIT} void lookups (names that
                  answer with nothing).
                  {shown.complete ? "" : " The count is partial: the walk stopped before following every include, so the real count may be higher."}
                </p>
              </div>
            </div>
          ) : null}

          {shown.scan ? (
            <div>
              <FigureHead name="Findings" meta="from the scanner" className="mb-4" />
              <Findings
                issues={[
                  ...issuesFor("spf_", shown.scan.issues),
                  // The scanner turns each include problem into its own finding
                  // (a ptr is a warning, a broken include an error). Listing the
                  // problem again here showed a ptr twice, once as "Fix". Only a
                  // problem no finding carries is added.
                  ...shown.problems
                    .filter((message) => !(shown.scan?.issues ?? []).some((issue) => issue.message === message))
                    .map((message, i) => ({
                      severity: "error" as const,
                      code: `problem-${i}`,
                      title: "A fault in the include chain",
                      message,
                    })),
                ]}
                none="The scanner raised nothing about this record."
              />
            </div>
          ) : null}
        </div>

        <div className="min-w-0">
          <FigureHead name="Where the lookups come from" meta="each include is its service's own line" className="mb-6" />
          {shown.tree.length === 0 ? (
            <p className="text-[15px] text-fg-2">
              {shown.record
                ? "This record has no term that costs a lookup: only ip4, ip6 and all, which receivers check without asking DNS."
                : "No record, so nothing to follow."}
            </p>
          ) : (
            <SpfTree nodes={shown.tree} domain={shown.domain} />
          )}
        </div>
      </div>
    </section>
  );
}

/** Ten stations: used in ink, ahead grey dashed, past ten dashed red to a red bar. */
function LookupCount({ count }: { count: number }) {
  const used = Math.min(count, LIMIT);
  const over = count - LIMIT;
  const pos = (i: number) => `calc((100% - 15px) * ${i / (LIMIT - 1)})`;
  return (
    <figure className="m-0" data-testid="tool-spf-count" data-count={count}>
      <div className="flex items-center gap-0">
        <div
          role="img"
          aria-label={`${count} of ${LIMIT} DNS lookups${over > 0 ? `: ${over} over the limit` : ""}.`}
          className="relative h-[15px] min-w-0 flex-1"
        >
          {/* Ahead: grey dashed. */}
          <span
            aria-hidden
            className="absolute left-[7px] right-[7px] top-[5.5px] h-[4px] bg-[repeating-linear-gradient(90deg,var(--color-fg-4)_0_6px,transparent_6px_11px)]"
          />
          {used > 1 ? (
            <span aria-hidden className="absolute left-[7px] top-[5px] h-[5px] rounded-full bg-fg" style={{ width: `calc((100% - 15px) * ${(used - 1) / (LIMIT - 1)})` }} />
          ) : null}
          {Array.from({ length: LIMIT }, (_, i) => (
            <span
              key={i}
              aria-hidden
              style={{ left: pos(i) }}
              className={clsx("absolute top-0 size-[15px] rounded-full border-[3px]", i < used ? "border-fg bg-fg" : "border-rule-2 bg-paper")}
            />
          ))}
        </div>
        {over > 0 ? (
          <span aria-hidden className="flex h-[15px] w-14 shrink-0 items-center sm:w-20">
            <span className="h-[4px] flex-1 bg-[repeating-linear-gradient(90deg,var(--color-fail)_0_6px,transparent_6px_11px)]" />
            <span className="h-[15px] w-[5px] rounded-[1.5px] bg-fail" />
          </span>
        ) : null}
      </div>
      <figcaption className="mt-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-[14px] text-fg-4">
        <span>
          <span className={clsx("tnum text-[22px] font-bold tracking-[-0.02em]", over > 0 ? "text-fail" : "text-fg")}>{count}</span>{" "}
          of {LIMIT} lookups
        </span>
        <span>{over > 0 ? <span className="font-semibold text-fail">{over} over the limit</span> : `${LIMIT - count} left`}</span>
      </figcaption>
    </figure>
  );
}

/**
 * The record as a map. The domain's own terms sit on an ink trunk; each term
 * that pulls in more draws what it includes on its own coloured line.
 */
function SpfTree({ nodes, domain }: { nodes: SpfNode[]; domain: string }) {
  let colour = 0;
  return (
    <div data-testid="tool-spf-tree">
      <p className="flex items-center gap-3 pb-3">
        <span aria-hidden className="size-[19px] shrink-0 rounded-full border-[3px] border-fg bg-paper" />
        <span className="data min-w-0 [overflow-wrap:anywhere] text-[15px] font-bold text-fg">
          <Breakable text={domain} at={NAME_BREAKS} />
        </span>
      </p>
      <ol className="m-0 list-none p-0">
        {nodes.map((node, i) => {
          const line = node.children?.length ? LINE[colour++ % LINE.length] : null;
          return <TreeRow key={`${node.term}-${i}`} node={node} last={i === nodes.length - 1} trunk="bg-fg" ring="border-fg" line={line} depth={0} />;
        })}
      </ol>
    </div>
  );
}

function TreeRow({
  node,
  last,
  trunk,
  ring,
  line,
  depth,
}: {
  node: SpfNode;
  last: boolean;
  /** The line this row's station sits on. */
  trunk: string;
  ring: string;
  /** The coloured line its children are drawn on, when it has any. */
  line: (typeof LINE)[number] | null;
  depth: number;
}) {
  const children = node.children ?? [];
  const warn = node.note && /loop|permanent error|does not exist|no spf record|names no domain/i.test(node.note);
  return (
    <li className={clsx("relative pl-8", last ? "pb-0" : "pb-4")}>
      {/* The trunk runs past this station to the next one. The first row also
          takes it up to the origin above. */}
      {last ? (
        <span aria-hidden className={clsx("absolute left-[7px] top-[-12px] h-[20px] w-[5px]", trunk)} />
      ) : (
        <span aria-hidden className={clsx("absolute bottom-0 left-[7px] top-[-12px] w-[5px]", trunk)} />
      )}
      <span aria-hidden className={clsx("absolute left-[1px] top-[2px] size-[17px] rounded-full border-[3px] bg-paper", ring)} />
      <p className="flex min-w-0 items-baseline justify-between gap-3 leading-[21px]">
        <span className={clsx("data min-w-0 [overflow-wrap:anywhere] text-[14.5px]", depth === 0 ? "font-semibold text-fg" : "text-fg")}>
          <Breakable text={node.term} at={NAME_BREAKS} />
        </span>
        <span className="tnum shrink-0 whitespace-nowrap text-[13.5px] text-fg-4">
          {node.lookups} lookup{node.lookups === 1 ? "" : "s"}
        </span>
      </p>
      {node.note ? <p className={clsx("mt-0.5 text-[13.5px] leading-[1.45]", warn ? "font-semibold text-fail" : "text-fg-4")}>{node.note}</p> : null}
      {children.length > 0 && line ? (
        <ol className="m-0 mt-3 list-none p-0 pl-1">
          {children.map((child, i) => (
            <TreeRow
              key={`${child.term}-${i}`}
              node={child}
              last={i === children.length - 1}
              trunk={line.bg}
              ring={line.border}
              line={child.children?.length ? line : null}
              depth={depth + 1}
            />
          ))}
        </ol>
      ) : null}
    </li>
  );
}
