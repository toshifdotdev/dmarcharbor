"use client";

/**
 * bimi-tool.tsx — /tools/bimi: whether a domain's logo can show beside its
 * mail, drawn as the route a logo travels.
 *
 * Four stations, in the order a mailbox provider checks them: the BIMI record
 * at default._bimi, a DMARC policy strong enough (quarantine or reject, not
 * in testing), the logo file against the SVG Tiny PS rules, and the
 * certificate (VMC or CMC) the largest providers ask for. Passed stations are
 * green, a failed one is a red bar, an absent one is closed and grey. The
 * logo's own checks are listed the same way.
 *
 * The scanner fetches the logo through a guarded fetcher and never shows it:
 * this page draws no remote image. Everything after a lookup is what POST
 * /api/scan returned; at rest the page shows a sample, labelled as one.
 *
 * Test hooks: tool-bimi-input, tool-bimi-submit, tool-bimi (data-state),
 * tool-bimi-route, tool-bimi-logo.
 */

import { useState } from "react";
import { clsx } from "clsx";
import { CopyButton } from "@/components/ui/copy";
import { StateWord } from "../ops-parts";
import { Breakable, Findings, StationList, issuesFor, type StationItem } from "./figures";
import { FigureHead, LookupLine, LookupStatus } from "./lookup-line";
import { lookupDomain, useScan, type BimiCheck, type ToolScan } from "./scan";

type Bimi = NonNullable<ToolScan["bimi"]>;

const CHECKS: Array<{ key: BimiCheck; name: string; kind: string }> = [
  { key: "svgRoot", name: "An SVG file", kind: "the file is an SVG document" },
  { key: "tinyPsProfile", name: "SVG Tiny PS", kind: 'baseProfile="tiny-ps", the profile BIMI requires' },
  { key: "version12", name: "SVG 1.2", kind: 'version="1.2"' },
  { key: "title", name: "A title", kind: "a <title> element naming the brand" },
  { key: "noForbiddenElements", name: "Nothing active", kind: "no scripts, event attributes or other forbidden elements" },
  { key: "noExternalReferences", name: "Self-contained", kind: "no links to outside files" },
  { key: "withinSizeLimit", name: "Small enough", kind: "32 KB at most" },
];

const SAMPLE: Bimi = {
  status: "found",
  record: "v=BIMI1; l=https://pellowyn-dental.example/bimi/logo.svg; a=https://pellowyn-dental.example/bimi/vmc.pem",
  logoUrl: "https://pellowyn-dental.example/bimi/logo.svg",
  authorityUrl: "https://pellowyn-dental.example/bimi/vmc.pem",
  declined: false,
  problems: [],
  dmarc: { qualifies: true, reasons: [] },
  logo: {
    status: "fetched",
    bytes: 4812,
    checks: {
      svgRoot: true,
      tinyPsProfile: true,
      version12: true,
      title: true,
      noForbiddenElements: true,
      noExternalReferences: true,
      withinSizeLimit: true,
    },
  },
};

function route(bimi: Bimi | null, domain: string): { items: StationItem[]; shows: boolean } {
  const recordOk = Boolean(bimi && bimi.status === "found" && !bimi.declined && bimi.problems.length === 0);
  const record: StationItem = !bimi || bimi.status !== "found"
    ? {
        key: "record",
        state: bimi?.status === "error" ? "failed" : "closed",
        name: "BIMI record",
        meta: <span className="data">default._bimi.{domain}</span>,
        children: bimi?.status === "error" ? "The lookup failed, so nothing was measured." : "No record: mailbox providers show no logo.",
      }
    : bimi.declined
      ? {
          key: "record",
          state: "closed",
          name: "BIMI record",
          meta: <span className="data">default._bimi.{domain}</span>,
          children: "Published with an empty l=, which declines BIMI on purpose.",
        }
      : {
          key: "record",
          state: recordOk ? "passed" : "failed",
          name: "BIMI record",
          meta: <span className="data">default._bimi.{bimi.inheritedFrom ?? domain}</span>,
          children: (
            <>
              {bimi.inheritedFrom ? (
                <p>
                  None of its own: the record of <span className="data">{bimi.inheritedFrom}</span> applies.
                </p>
              ) : null}
              {bimi.problems.length > 0 ? (
                <ul className="m-0 list-none p-0 text-fail">
                  {bimi.problems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              ) : (
                <p className="text-ok">Published and well formed.</p>
              )}
            </>
          ),
        };

  const dmarcItem: StationItem = !bimi
    ? { key: "dmarc", state: "closed", name: "DMARC policy", meta: "quarantine or reject", children: "Not checked without a BIMI record." }
    : bimi.dmarc.dependsOnParent
      ? {
          key: "dmarc",
          state: "closed",
          name: "DMARC policy",
          meta: "quarantine or reject",
          children: "This subdomain has no DMARC record, so its parent's policy decides. Look up the parent domain.",
        }
      : bimi.dmarc.qualifies
        ? { key: "dmarc", state: "passed", name: "DMARC policy", meta: "quarantine or reject", children: <span className="text-ok">Strong enough for a logo.</span> }
        : {
            key: "dmarc",
            state: "failed",
            name: "DMARC policy",
            meta: "quarantine or reject",
            children: (
              <ul className="m-0 list-none p-0 text-fail">
                {(bimi.dmarc.reasons.length ? bimi.dmarc.reasons : ["The DMARC policy does not let a logo show."]).map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            ),
          };

  const logo = bimi?.logo ?? null;
  const checksOk = logo?.checks ? Object.values(logo.checks).every(Boolean) : false;
  const logoItem: StationItem = !bimi?.logoUrl
    ? { key: "logo", state: "closed", name: "Logo file", meta: "SVG Tiny PS", children: "No logo address in the record." }
    : !logo
      ? { key: "logo", state: "closed", name: "Logo file", meta: <span className="data">{bimi.logoUrl}</span>, children: "Not fetched." }
      : logo.status === "fetched" && checksOk
        ? {
            key: "logo",
            state: "passed",
            name: "Logo file",
            meta: <span className="data">{bimi.logoUrl}</span>,
            children: <span className="text-ok">Fetched{logo.bytes ? `, ${(logo.bytes / 1024).toFixed(1)} KB` : ""}, and it meets every rule.</span>,
          }
        : {
            key: "logo",
            state: "failed",
            name: "Logo file",
            meta: <span className="data">{bimi.logoUrl}</span>,
            children: (
              <span className="text-fail">
                {logo.status === "unavailable"
                  ? `Could not be fetched${logo.detail ? `: ${logo.detail}` : "."}`
                  : `Fetched, but it breaks ${logo.checks ? Object.values(logo.checks).filter((v) => !v).length : "a"} of the rules below.`}
              </span>
            ),
          };

  const certItem: StationItem = bimi?.authorityUrl
    ? {
        key: "cert",
        state: "open",
        name: "Certificate",
        meta: <span className="data">{bimi.authorityUrl}</span>,
        children: "A VMC or CMC is named. This lookup does not validate the certificate itself.",
      }
    : {
        key: "cert",
        state: "closed",
        name: "Certificate",
        meta: "VMC or CMC",
        children: "None named. Gmail and Apple Mail show a logo only with one; some other providers show it without.",
      };

  const shows = recordOk && Boolean(bimi?.dmarc.qualifies) && logo?.status === "fetched" && checksOk;
  return { items: [record, dmarcItem, logoItem, certItem], shows };
}

export function BimiTool() {
  const [domain, setDomain] = useState("");
  const { state, run, reset } = useScan();
  const busy = state.phase === "busy";
  const scan = state.phase === "done" ? state.result : null;
  const bimi: Bimi | null = scan ? (scan.bimi ?? null) : SAMPLE;
  const shownDomain = scan?.domain ?? "pellowyn-dental.example";
  const { items, shows } = route(bimi, shownDomain);

  function submit() {
    const wanted = lookupDomain(domain);
    if (!wanted) return;
    setDomain(wanted);
    void run(wanted);
  }

  return (
    <section data-testid="tool-bimi" data-state={state.phase} aria-label="BIMI record lookup">
      <LookupLine
        id="tool-bimi"
        prefix={<>TXT&nbsp;default._bimi.</>}
        value={domain}
        onChange={setDomain}
        onSubmit={submit}
        busy={busy}
        submitLabel="Check the logo"
        busyLabel="Reading DNS and the logo"
      />
      <LookupStatus
        state={state}
        idle="Showing a sample record. Type any domain to check its own."
        read={
          <>
            Read from public DNS just now; the logo was fetched to check it and not kept.{" "}
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
          "mt-6 grid gap-x-16 gap-y-14 transition-opacity duration-150 min-[68.75rem]:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)]",
          busy && "opacity-35",
        )}
      >
        <div className="flex min-w-0 flex-col gap-12">
          <figure className="m-0">
            <FigureHead name={scan ? "The record" : "Sample record"} meta={<span className="data">default._bimi.{shownDomain}</span>} />
            <div className="mt-4 flex items-start gap-3">
              <p className={clsx("data min-w-0 flex-1 [overflow-wrap:anywhere] text-[16px] font-semibold leading-[1.5] tracking-[-0.01em]", bimi?.record ? "text-fg" : "text-fail")}>
                {(bimi?.record ? <Breakable text={bimi.record} /> : null) ?? (bimi?.status === "error" || !bimi ? "The lookup could not read the record." : `No record at default._bimi.${shownDomain}`)}
              </p>
              {bimi?.record ? <CopyButton value={bimi.record} label="Copy the BIMI record" /> : null}
            </div>
            {scan ? null : <figcaption className="mt-3 text-[14px] text-fg-4">Sample data on a reserved .example domain.</figcaption>}
          </figure>

          <div data-testid="tool-bimi-route" data-shows={shows ? "yes" : "no"}>
            <FigureHead name="On the way to the inbox" meta="what a mailbox provider checks, in order" className="mb-6" />
            <StationList label="BIMI checks in order" items={items} />
            <div className="mt-6 border-t border-rule pt-4">
              {shows ? (
                <StateWord shape="square" tone="ok" className="text-[16px]! whitespace-normal">
                  {bimi?.authorityUrl ? "The logo can show" : "The logo can show where no certificate is required"}
                </StateWord>
              ) : (
                <StateWord shape="ring" tone="void" className="text-[16px]! whitespace-normal">
                  No logo shows yet
                </StateWord>
              )}
            </div>
          </div>

          {scan ? (
            <div>
              <FigureHead name="Findings" meta="from the scanner" className="mb-4" />
              <Findings issues={issuesFor("bimi_", scan.issues)} none="The scanner raised nothing about BIMI." />
            </div>
          ) : null}
        </div>

        <div className="min-w-0" data-testid="tool-bimi-logo">
          <FigureHead name="The logo file" meta="the rules BIMI sets for it" className="mb-6" />
          {bimi?.logo?.checks ? (
            <StationList
              label="Logo file rules"
              items={CHECKS.map((c) => ({
                key: c.key,
                state: bimi.logo!.checks![c.key] ? "passed" : "failed",
                name: c.name,
                meta: c.kind,
              }))}
            />
          ) : (
            <p className="text-[15px] leading-[1.5] text-fg-2">
              {bimi?.logo?.status === "unavailable"
                ? "The logo could not be fetched, so its rules were not checked."
                : "No logo was fetched, so its rules were not checked."}
            </p>
          )}
          <p className="mt-6 max-w-[42ch] text-[14px] leading-[1.5] text-fg-4">
            The logo is fetched once to check it, through a fetcher that refuses private addresses and redirects. It is never
            shown on this page.
          </p>
        </div>
      </div>
    </section>
  );
}
