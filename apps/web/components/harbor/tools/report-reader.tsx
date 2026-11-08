"use client";

/**
 * report-reader.tsx — /tools/dmarc-report-reader: a DMARC aggregate report,
 * read as people read it.
 *
 * The file is opened in the browser (lib/aggregate-report.ts) and never
 * uploaded: XML, .xml.gz and .zip, dropped, chosen or pasted. At rest the
 * page reads a sample report, labelled as one.
 *
 * Three readings of the same file:
 *   the split     every message, passed DMARC in green and failed in red;
 *   the map       each source as its own line through the SPF and DKIM
 *                 checks to what the receiver did, coloured one line per
 *                 source the way the domain page draws senders, and the
 *                 sources that failed both as dashed red lines;
 *   the table     every row, timetable style, for the person fixing it.
 *
 * Test hooks: report-drop, report-file, report-paste, report-reader
 * (data-state), report-split, report-map, report-table.
 */

import Link from "next/link";
import { useMemo, useRef, useState, type DragEvent } from "react";
import { clsx } from "clsx";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/choice";
import { Table, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import { parseAggregateReport, readReportFile, ReportReadError, type AggregateReport, type ReportRow } from "@/lib/aggregate-report";
import { StateWord } from "../ops-parts";
import { PolicyLine } from "./figures";
import { FigureHead } from "./lookup-line";
import { SAMPLE_REPORT } from "./report-sample";

const LINE = ["bg-route-blue", "bg-route-orange", "bg-route-green", "bg-route-purple", "bg-route-yellow"] as const;
const MAP_ROWS = 10;
const TABLE_ROWS = 300;

type Loaded = { kind: "sample" | "file"; name: string; report: AggregateReport };

function n(value: number): string {
  return value.toLocaleString("en-GB");
}

function day(d: Date | null): string {
  return d ? d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "not stated";
}

/** What the row's own evidence says the source is: its DKIM signer, else its envelope domain. */
function sourceHint(row: ReportRow): string {
  const signer = row.dkim.find((d) => d.result === "pass")?.domain ?? row.dkim[0]?.domain;
  if (signer) return `signed by ${signer}`;
  if (row.envelopeFrom) return `envelope ${row.envelopeFrom}`;
  return "no signature";
}

export function ReportReader() {
  const sample = useMemo<Loaded>(() => ({ kind: "sample", name: "sample report", report: SAMPLE_REPORT }), []);
  const [loaded, setLoaded] = useState<Loaded>(sample);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [paste, setPaste] = useState("");
  const input = useRef<HTMLInputElement | null>(null);

  async function open(file: File) {
    setBusy(true);
    setError(null);
    try {
      setLoaded({ kind: "file", name: file.name, report: await readReportFile(file) });
    } catch (e) {
      setError(e instanceof ReportReadError ? e.message : "The file could not be opened. Try the XML inside it, pasted below.");
    } finally {
      setBusy(false);
    }
  }

  function readPasted() {
    setError(null);
    try {
      setLoaded({ kind: "file", name: "pasted XML", report: parseAggregateReport(paste) });
    } catch (e) {
      setError(e instanceof ReportReadError ? e.message : "That could not be read as a DMARC report.");
    }
  }

  function drop(event: DragEvent) {
    event.preventDefault();
    setOver(false);
    const file = event.dataTransfer.files?.[0];
    if (file) void open(file);
  }

  const report = loaded.report;
  const share = report.totals.messages ? report.totals.passed / report.totals.messages : 0;

  return (
    <section data-testid="report-reader" data-state={busy ? "busy" : loaded.kind} aria-label="DMARC aggregate report reader">
      <div
        data-testid="report-drop"
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={drop}
        className={clsx(
          "flex flex-col items-start gap-4 rounded-[16px] border-[1.5px] border-dashed px-6 py-7 transition-colors duration-[120ms] sm:flex-row sm:items-center",
          over ? "border-act bg-paper-3" : "border-rule-2",
        )}
      >
        <div className="min-w-0 flex-1">
          <p className="text-[17px] font-bold text-fg">Drop a report here</p>
          <p className="mt-1 text-[14.5px] leading-[1.5] text-fg-2">
            The XML, or the .zip or .xml.gz file it arrived in. It is read in this browser and never uploaded.
          </p>
        </div>
        <input
          ref={input}
          type="file"
          accept=".xml,.gz,.zip,application/xml,text/xml,application/gzip,application/zip"
          className="sr-only"
          data-testid="report-file"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void open(file);
          }}
        />
        <Button variant="primary" size="lg" busy={busy} busyLabel="Opening the report" onClick={() => input.current?.click()}>
          Choose a file
        </Button>
      </div>

      <details className="mt-4">
        <summary className="cursor-pointer text-[14.5px] font-semibold text-fg marker:text-fg-4">Or paste the XML</summary>
        <div className="mt-3 flex flex-col gap-3">
          <Textarea
            mono
            rows={6}
            value={paste}
            onChange={(e) => setPaste(e.target.value)}
            placeholder={'<?xml version="1.0"?>\n<feedback> ...'}
            spellCheck={false}
            data-testid="report-paste"
          />
          <Button variant="secondary" onClick={readPasted} disabled={!paste.trim()} className="self-start">
            Read the pasted report
          </Button>
        </div>
      </details>

      <div aria-live="polite" className="min-h-[40px] pt-3 text-[13.5px] leading-[18px]">
        {error ? (
          <p role="alert" className="font-semibold text-fail">
            {error}
          </p>
        ) : loaded.kind === "sample" ? (
          <p className="text-fg-4">Showing a sample report. Drop one of your own to read it.</p>
        ) : (
          <p className="text-fg-4">
            Read <span className="data text-fg-2">{loaded.name}</span> in this browser.{" "}
            <button
              type="button"
              className="font-semibold text-fg underline decoration-rule-2 underline-offset-[3px] hover:decoration-fg"
              onClick={() => {
                setLoaded(sample);
                setError(null);
              }}
            >
              Back to the sample
            </button>
          </p>
        )}
      </div>

      <div className={clsx("mt-6 flex flex-col gap-16 transition-opacity duration-150", busy && "opacity-35")}>
        <div className="grid gap-x-16 gap-y-12 min-[68.75rem]:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="min-w-0">
            <FigureHead
              name={`Report from ${report.orgName}`}
              meta={<>{loaded.kind === "sample" ? "sample data · " : ""}{day(report.begin)} to {day(report.end)}</>}
            />
            <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-4">
              {[
                ["Messages", n(report.totals.messages), "text-fg"],
                ["Passed DMARC", n(report.totals.passed), "text-ok"],
                ["Failed DMARC", n(report.totals.failed), report.totals.failed ? "text-fail" : "text-fg"],
                ["Sources", n(report.totals.sources), "text-fg"],
              ].map(([label, value, tone]) => (
                <div key={label}>
                  <dt className="text-[14px] text-fg-4">{label}</dt>
                  <dd className={clsx("tnum mt-0.5 text-[30px] font-bold leading-none tracking-[-0.02em]", tone)}>{value}</dd>
                </div>
              ))}
            </dl>
            <div className="mt-6" data-testid="report-split">
              <div
                role="img"
                aria-label={`${n(report.totals.passed)} of ${n(report.totals.messages)} messages passed DMARC.`}
                className="flex h-[10px] gap-1"
              >
                {report.totals.passed > 0 ? <span className="h-full rounded-full bg-done" style={{ flexGrow: report.totals.passed, minWidth: 8 }} /> : null}
                {report.totals.failed > 0 ? <span className="h-full rounded-full bg-fail" style={{ flexGrow: report.totals.failed, minWidth: 8 }} /> : null}
                {report.totals.messages === 0 ? <span className="h-full flex-1 rounded-full bg-rule" /> : null}
              </div>
              <p className="mt-2 text-[14px] text-fg-2">
                <span className="tnum font-semibold text-fg">{Math.round(share * 1000) / 10}%</span> passed DMARC at{" "}
                {report.orgName}. Domain <span className="data text-fg">{report.policy.domain}</span>
                {loaded.kind === "file" && report.reportId ? (
                  <>
                    , report <span className="data">{report.reportId}</span>
                  </>
                ) : null}
                .
              </p>
            </div>
          </div>

          <div className="min-w-0">
            <FigureHead name="Policy published" meta="as the receiver read it on the day" className="mb-6" />
            <PolicyLine
              policy={report.policy.p}
              note={
                report.policy.p === "none"
                  ? `At p=none the receiver delivered failing mail as usual${report.totals.failed ? `, so ${n(report.totals.failed)} messages that failed were still delivered` : ""}.`
                  : report.policy.testing === "y"
                    ? "Testing mode was on, so failing mail was treated one step softer."
                    : `Failing mail was ${report.policy.p === "reject" ? "refused" : "sent to spam"}, unless the receiver overrode it (a reason is listed in the table).`
              }
            />
          </div>
        </div>

        <SourceMap rows={report.rows} />

        <div data-testid="report-table">
          <FigureHead
            name="Every row"
            meta={report.rows.length > TABLE_ROWS ? `the ${TABLE_ROWS} largest of ${n(report.rows.length)}` : `${n(report.rows.length)} rows, largest first`}
            className="mb-4"
          />
          <Table caption="Each source in the report, with its checks and what the receiver did" minWidth={880}>
            <THead>
              <tr>
                <Th>Source</Th>
                <Th numeric>Messages</Th>
                <Th>Envelope</Th>
                <Th>DKIM</Th>
                <Th>SPF</Th>
                <Th>DMARC</Th>
                <Th>Receiver did</Th>
              </tr>
            </THead>
            <TBody>
              {report.rows.slice(0, TABLE_ROWS).map((row, i) => (
                <Tr key={`${row.sourceIp}-${i}`}>
                  <Td mono>{row.sourceIp}</Td>
                  <Td numeric>{n(row.count)}</Td>
                  <Td mono muted>
                    {row.envelopeFrom ?? "not given"}
                  </Td>
                  <Td>
                    <CheckCell aligned={row.dkimAligned} detail={row.dkim.map((d) => `${d.domain}${d.selector ? ` (${d.selector})` : ""}: ${d.result}`).join(", ")} />
                  </Td>
                  <Td>
                    <CheckCell aligned={row.spfAligned} detail={row.spf.map((s) => `${s.domain}: ${s.result}`).join(", ")} />
                  </Td>
                  <Td>
                    {row.dmarc === "pass" ? (
                      <StateWord shape="square" tone="ok">
                        Pass
                      </StateWord>
                    ) : (
                      <StateWord shape="diamond" tone="fail">
                        Fail
                      </StateWord>
                    )}
                  </Td>
                  <Td>
                    <span className="text-fg">{row.disposition === "none" ? "Delivered" : row.disposition === "quarantine" ? "Quarantined" : row.disposition === "reject" ? "Refused" : row.disposition}</span>
                    {row.reasons.length ? <span className="block text-meta text-fg-3">{row.reasons.join(", ")}</span> : null}
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        </div>

        <div className="max-w-[44rem] border-t border-rule pt-6">
          <p className="text-[16px] leading-[1.55] text-fg-2">
            One report is one receiver&rsquo;s day. Monitoring reads every report from every receiver for every client domain,
            names the service behind each address, and says which ones still need SPF or DKIM before the move to enforcement.{" "}
            <Link href="/sign-up" className="link font-semibold">
              Start free
            </Link>
          </p>
        </div>
      </div>
    </section>
  );
}

function CheckCell({ aligned, detail }: { aligned: "pass" | "fail" | "none"; detail: string }) {
  return (
    <span className="block min-w-0">
      {aligned === "pass" ? (
        <StateWord shape="square" tone="ok">
          Aligned pass
        </StateWord>
      ) : (
        <StateWord shape="ring" tone={aligned === "fail" ? "fail" : "void"}>
          {aligned === "fail" ? "Not aligned" : "None"}
        </StateWord>
      )}
      {detail ? <span className="data mt-0.5 block text-meta text-fg-3 [overflow-wrap:anywhere]">{detail}</span> : null}
    </span>
  );
}

/**
 * Each source as a line: through SPF, then DKIM, to what the receiver did.
 * A check that passed aligned is a station filled green; one that did not is
 * a closed station. A source that passed is drawn in its own line colour; one
 * that failed both is a dashed red line ending in a red bar.
 */
function SourceMap({ rows }: { rows: ReportRow[] }) {
  const shown = rows.slice(0, MAP_ROWS);
  let colour = 0;
  return (
    <div data-testid="report-map">
      <FigureHead name="Who sent as the domain" meta={rows.length > MAP_ROWS ? `the ${MAP_ROWS} largest sources of ${n(rows.length)}` : "each source, largest first"} className="mb-5" />
      <div className="hidden grid-cols-[minmax(0,15rem)_minmax(0,1fr)_7.5rem] gap-x-6 pb-2 text-[13.5px] font-semibold text-fg-3 min-[900px]:grid">
        <span>Source</span>
        <span className="relative h-[18px]">
          <span className="absolute left-[25%] -translate-x-1/2 whitespace-nowrap">SPF aligned</span>
          <span className="absolute left-[62%] -translate-x-1/2 whitespace-nowrap">DKIM aligned</span>
        </span>
        <span>Result</span>
      </div>
      <ol className="m-0 list-none p-0">
        {shown.map((row, i) => {
          const passed = row.dmarc === "pass";
          const line = passed ? LINE[colour++ % LINE.length] : null;
          return (
            <li key={`${row.sourceIp}-${i}`} className="grid gap-x-6 gap-y-2 border-b border-rule py-3.5 last:border-b-0 min-[900px]:grid-cols-[minmax(0,15rem)_minmax(0,1fr)_7.5rem] min-[900px]:items-center">
              <p className="min-w-0">
                <span className="data block text-[14.5px] font-semibold text-fg">{row.sourceIp}</span>
                <span className="block text-[13.5px] text-fg-4 [overflow-wrap:anywhere]">
                  <span className="tnum font-semibold text-fg-2">{n(row.count)}</span> messages · {sourceHint(row)}
                </span>
              </p>
              <div className="relative h-[19px]" role="img" aria-label={`${row.sourceIp}: SPF ${row.spfAligned === "pass" ? "aligned" : "not aligned"}, DKIM ${row.dkimAligned === "pass" ? "aligned" : "not aligned"}, DMARC ${row.dmarc}.`}>
                {line ? (
                  <span aria-hidden className={clsx("absolute left-0 right-[11px] top-[7px] h-[5px] rounded-full", line)} />
                ) : (
                  <span aria-hidden className="absolute left-0 right-[11px] top-[7px] h-[5px] bg-[repeating-linear-gradient(90deg,var(--color-fail)_0_9px,transparent_9px_15px)]" />
                )}
                {[row.spfAligned, row.dkimAligned].map((v, j) => (
                  <span
                    key={j}
                    aria-hidden
                    style={{ left: `calc(${j === 0 ? 25 : 62}% - 9.5px)` }}
                    className={clsx("absolute top-0 size-[19px] rounded-full border-[3px]", v === "pass" ? "border-done bg-done" : "border-rule-2 bg-paper")}
                  />
                ))}
                {passed ? (
                  <span aria-hidden className="absolute right-0 top-0 h-[19px] w-[26px] rounded-full border-[3px] border-fg bg-paper" />
                ) : (
                  <span aria-hidden className="absolute right-[4px] top-0 h-[19px] w-[5px] rounded-[1.5px] bg-fail" />
                )}
              </div>
              <div>
                {passed ? (
                  <StateWord shape="square" tone="ok">
                    Passed
                  </StateWord>
                ) : (
                  <StateWord shape="diamond" tone="fail">
                    Failed
                  </StateWord>
                )}
                <span className="block text-[13px] text-fg-4">
                  {row.disposition === "none" ? "delivered" : row.disposition === "quarantine" ? "quarantined" : "refused"}
                </span>
              </div>
            </li>
          );
        })}
      </ol>
      <p className="mt-3 text-[13.5px] leading-[1.5] text-fg-4">
        A station filled green is a check that passed for a domain aligned with the From line. A source needs one of the two
        for DMARC to pass. Dashed red lines are sources that failed both: an unlisted service, a forwarder, or someone
        sending as the domain.
      </p>
    </div>
  );
}
