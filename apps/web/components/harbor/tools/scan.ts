"use client";

/**
 * scan.ts — the one lookup every free tool runs: POST /api/scan, the public
 * scanner the home page's check uses. No account, nothing stored.
 *
 * The response type below is the part of the API's ScanResult
 * (apps/api/src/models/scan.model.ts) the tools read; every field the scanner
 * may leave out on an old or failed lookup is optional here too.
 *
 * A 429 is a pause, not a failure: the lookup is shared and rate limited
 * (20 a minute from one address), and the answer says how long to wait.
 */

import { useCallback, useRef, useState } from "react";
import { retryAfterFrom } from "@/lib/retry-after";
import { cleanDomain } from "../first-domain";

export type Lookup = "found" | "missing" | "error";

export interface ToolIssue {
  severity: "info" | "warning" | "error";
  code: string;
  title: string;
  message: string;
  recommendation?: string;
}

export interface SpfNode {
  term: string;
  lookups: number;
  children?: SpfNode[];
  note?: string;
}

export interface ToolScan {
  domain: string;
  scannedAt: string;
  status: "healthy" | "needs_attention" | "missing" | "error";
  dmarc: {
    status: Lookup;
    record?: string;
    policy: "none" | "quarantine" | "reject" | "unknown";
    tags: Record<string, string>;
    aggregateMailtoTargets?: string[];
    aggregateWebTargets?: string[];
    testing?: boolean;
    delegatedTo?: string | null;
    effectivePolicy?: "none" | "quarantine" | "reject" | "unknown";
    notices?: ToolIssue[];
    error?: string;
  };
  spf: {
    status: Lookup;
    record?: string;
    valid: boolean;
    lookupCount: number;
    voidLookupCount?: number;
    lookupLimitExceeded?: boolean;
    voidLookupLimitExceeded?: boolean;
    lookupTree?: SpfNode[];
    problems?: string[];
    lookupsComplete?: boolean;
    error?: string;
  };
  dkim: {
    status: Lookup;
    selectors: string[];
    checkedSelectors: string[];
    records: Record<string, string>;
    discoveredVia?: Record<string, string>;
    skippedSelectors?: string[];
    revokedSelectors?: string[];
    error?: string;
  };
  bimi?: {
    status: Lookup;
    record?: string;
    inheritedFrom?: string;
    logoUrl: string | null;
    authorityUrl: string | null;
    declined: boolean;
    problems: string[];
    dmarc: { qualifies: boolean; reasons: string[]; dependsOnParent?: true };
    logo: null | {
      status: "fetched" | "unavailable" | "invalid";
      failure?: string;
      detail?: string;
      bytes?: number;
      checks?: Record<BimiCheck, boolean>;
    };
    error?: string;
  };
  issues: ToolIssue[];
}

export type BimiCheck =
  | "svgRoot"
  | "tinyPsProfile"
  | "version12"
  | "title"
  | "noForbiddenElements"
  | "noExternalReferences"
  | "withinSizeLimit";

export type ScanState =
  | { phase: "idle" }
  | { phase: "busy"; domain: string }
  | { phase: "done"; result: ToolScan; selector: string | null }
  | { phase: "failed"; message: string }
  | { phase: "paused"; wait: number | null };

/** What people paste (a URL, an address, _dmarc.name, a trailing dot) to the domain itself. */
export function lookupDomain(raw: string): string {
  return cleanDomain(raw.trim().replace(/^_dmarc\./i, "").replace(/^[a-z0-9-]+\._domainkey\./i, "").replace(/^default\._bimi\./i, ""));
}

/** One DNS label, the same rule the API applies to a selector. */
export const SELECTOR = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function useScan() {
  const [state, setState] = useState<ScanState>({ phase: "idle" });
  // Only the latest lookup may set the answer: a slow earlier one must not
  // replace a newer one when it finally returns.
  const latest = useRef(0);

  const run = useCallback(async (domain: string, selector?: string | null) => {
    const ticket = ++latest.current;
    setState({ phase: "busy", domain });
    try {
      const res = await fetch("/api/scan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(selector ? { domain, selector } : { domain }),
      });
      if (ticket !== latest.current) return;
      if (res.status === 429) {
        setState({ phase: "paused", wait: retryAfterFrom(res.headers) });
        return;
      }
      const body = (await res.json().catch(() => null)) as ToolScan | { error?: { message?: string } } | null;
      if (ticket !== latest.current) return;
      if (!res.ok || !body || !("dmarc" in body)) {
        setState({
          phase: "failed",
          message: (body && "error" in body ? body.error?.message : null) ?? "That lookup could not run. Check the domain and try again.",
        });
        return;
      }
      setState({ phase: "done", result: body, selector: selector ?? null });
    } catch {
      if (ticket === latest.current) setState({ phase: "failed", message: "That lookup could not run. Check your connection and try again." });
    }
  }, []);

  const reset = useCallback(() => {
    latest.current += 1;
    setState({ phase: "idle" });
  }, []);

  return { state, run, reset };
}
