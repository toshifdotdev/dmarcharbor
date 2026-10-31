"use client";

/**
 * switch-kit.tsx — move a client's domains off another DMARC provider.
 *
 * The screen exists for one job: read what each domain publishes now, show the
 * record that adds our address alongside the incumbent's, and hand that record
 * to whoever runs DNS. It never edits a record it was not asked to change, and
 * it never claims to know what the other provider received.
 *
 * Three verdict lists stay separate all the way to the screen: domains created
 * or found, domains the API refused, and domains the plan blocked. A single
 * "some failed" count is what makes an import feel like it did nothing.
 */

import Link from "next/link";
import { useMemo, useState } from "react";
import { checkClientSwitches, importSwitchKit } from "@/lib/ops-client";
import { splitDomainList } from "@/lib/domain-list";
import { domainHref } from "@/lib/route-hrefs";
import type {
  DomainSwitchStatus,
  SwitchCheckRow,
  SwitchKitImportResult,
  SwitchKitResultRow,
} from "@/lib/types";
import { Badge, type Tone } from "@/components/ui/badge";
import { Button, ButtonLink } from "@/components/ui/button";
import { Textarea } from "@/components/ui/choice";
import { CopyButton } from "@/components/ui/copy";
import { Field, Select } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { Nil, Table, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import { DnsHandoff, zoneLines, type PublishRecord } from "./dns-handoff";
import { ActionRefusal, type ActionError } from "./plan-refusal";
import { RouteList } from "./route-list";

const MAX_DOMAINS = 100;

const LOOKUP_LABEL: Record<string, string> = {
  found: "Record found",
  no_record: "No record",
  multiple_records: "Multiple records",
  invalid: "Not a DMARC record",
  lookup_failed: "Not checked yet",
};

/** The switch's own states, as stations: what happens at each. */
const SWITCH_ROUTE: Array<{ name: string; kind: string }> = [
  {
    name: "Planned",
    kind: "Each domain is added in PENDING unless it is already here. Its live DMARC record is read and the other provider identified.",
  },
  {
    name: "Dual reporting",
    kind: "Publish the prepared record: it adds our address alongside theirs and keeps every other tag as it is.",
  },
  {
    name: "Cut over",
    kind: "Once reports arrive steadily from each receiver, publish the cutover record from each domain's page.",
  },
];

const SWITCH_STATUS: Record<DomainSwitchStatus, { label: string; tone: Tone }> = {
  PLANNED: { label: "Planned", tone: "neutral" },
  DUAL_REPORTING: { label: "Dual reporting", tone: "ok" },
  CUT_OVER: { label: "Cut over", tone: "ok" },
};

export function SwitchKit({
  organizationId,
  clients,
  initialClientId,
}: {
  organizationId: string;
  clients: Array<{ id: string; name: string; reportAddress: string }>;
  initialClientId: string | null;
}) {
  const [clientId, setClientId] = useState(initialClientId ?? clients[0]?.id ?? "");
  const [raw, setRaw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ActionError | null>(null);
  const [result, setResult] = useState<SwitchKitImportResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<ActionError | null>(null);
  const [checked, setChecked] = useState<SwitchCheckRow[] | null>(null);

  const parsed = useMemo(() => splitDomainList(raw), [raw]);
  const selectedClient = clients.find((client) => client.id === clientId) ?? null;
  const tooMany = parsed.names.length > MAX_DOMAINS;
  const canSubmit = Boolean(clientId) && parsed.names.length > 0 && !tooMany && !busy;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    setChecked(null);
    const response = await importSwitchKit(organizationId, clientId, parsed.names);
    setBusy(false);
    if (!response.ok) {
      setError(response.error);
      return;
    }
    setResult(response.data);
    if (response.data.failed.length === 0 && response.data.planBlocked.length === 0) {
      setRaw("");
    }
  }

  async function checkAll() {
    if (!clientId || checking) return;
    setChecking(true);
    setCheckError(null);
    const response = await checkClientSwitches(organizationId, clientId);
    setChecking(false);
    if (!response.ok) {
      setCheckError(response.error);
      return;
    }
    setChecked(response.data.results);
  }

  function changeClient(next: string) {
    setClientId(next);
    setResult(null);
    setChecked(null);
    setError(null);
    setCheckError(null);
  }

  const authorizationWarning = result?.results
    .flatMap((row) => row.plan.warnings)
    .find((warning) => warning.code === "authorization_missing");

  const zoneRecords: PublishRecord[] = (result?.results ?? []).flatMap((row) => {
    const records: PublishRecord[] = [];
    if (row.verification) {
      records.push({
        purpose: result?.ownershipNote ? `${row.name} ownership (alternative proof)` : `${row.name} ownership`,
        host: row.verification.host,
        value: row.verification.value,
        note: result?.ownershipNote
          ? "Either this TXT record or the DMARC record proves ownership."
          : "Publishing this TXT record proves the domain is managed by this workspace.",
        testId: `switch-verification-record-${row.domainId}`,
      });
    }
    if (row.plan.record) {
      records.push({
        purpose: `${row.name} DMARC record`,
        host: row.plan.record.host,
        value: row.plan.record.value,
        testId: `switch-dmarc-record-${row.domainId}`,
      });
    }
    return records;
  });
  const zone = zoneLines(zoneRecords);

  const checkedByDomain = new Map((checked ?? []).map((row) => [row.domainId, row]));
  const otherChecked = (checked ?? []).filter(
    (row) => !(result?.results ?? []).some((entry) => entry.domainId === row.domainId),
  );

  return (
    <div className="flex flex-col gap-10">
      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_360px] lg:gap-12">
        <div className="flex max-w-[640px] flex-col gap-5">
          <Field label="Client">
            <Select
              size="lg"
              value={clientId}
              onChange={(event) => changeClient(event.target.value)}
              data-testid="switch-client-picker"
            >
              {clients.map((client) => (
                <option key={client.id} value={client.id}>
                  {client.name}
                </option>
              ))}
            </Select>
          </Field>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="switch-domains" className="text-meta font-semibold text-fg-2">
              Domains to switch
            </label>
            <Textarea
              id="switch-domains"
              mono
              rows={8}
              value={raw}
              onChange={(event) => setRaw(event.target.value)}
              spellCheck={false}
              placeholder={"client.example\nmail.client.example\nclient-brand.example"}
              data-testid="switch-domain-input"
            />
            <p className="text-meta text-fg-3" aria-live="polite">
              <span className="tnum font-semibold text-fg">{parsed.names.length}</span> of {MAX_DOMAINS}
              {parsed.duplicates > 0 ? `, ${parsed.duplicates} duplicate${parsed.duplicates === 1 ? "" : "s"} skipped` : ""}
              {parsed.invalid.length > 0 ? (
                <span className="text-warn">
                  , {parsed.invalid.length} not a domain: <span className="data">{parsed.invalid.slice(0, 3).join(", ")}</span>
                  {parsed.invalid.length > 3 ? "…" : ""}
                </span>
              ) : null}
              . One per line, or separated by commas or spaces.
            </p>
            {tooMany ? (
              <p role="alert" className="text-meta font-semibold text-fail">
                A switch import accepts up to {MAX_DOMAINS} domains. Remove {parsed.names.length - MAX_DOMAINS} to
                continue.
              </p>
            ) : null}
          </div>

          <ActionRefusal error={error} />

          <Button
            variant="primary"
            size="lg"
            onClick={submit}
            busy={busy}
            busyLabel={`Checking ${parsed.names.length} domains`}
            disabled={!canSubmit}
            data-testid="switch-submit"
            className="self-start"
          >
            {parsed.names.length === 0
              ? "Check domains"
              : `Check ${parsed.names.length} domain${parsed.names.length === 1 ? "" : "s"}`}
          </Button>
        </div>

        <aside aria-labelledby="switch-route-head" className="flex flex-col gap-5 self-start border-t border-rule pt-6 lg:border-t-0 lg:pt-1">
          <p id="switch-route-head" className="text-ui font-semibold text-fg">
            How a switch runs
          </p>
          {/* The three states a switch moves through (DomainSwitchStatus), in order. */}
          <RouteList steps={SWITCH_ROUTE} here={0} />
          <p className="border-t border-rule pt-4 text-meta text-fg-3">
            Nothing is changed in DNS from this screen.
            {selectedClient ? (
              <>
                {" "}
                Reports for these domains are sent to{" "}
                <code className="data break-all text-fg-2">{selectedClient.reportAddress}</code>.
              </>
            ) : null}
          </p>
        </aside>
      </div>

      {authorizationWarning ? (
        <Notice tone="warn" title="One setup step for the operator" testId="switch-authorization-warning">
          {authorizationWarning.message}
        </Notice>
      ) : null}

      {result ? (
        <section aria-labelledby="switch-results-head" className="flex flex-col gap-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 id="switch-results-head" className="text-h3 font-bold tracking-[-0.01em]">
                Switch plan
              </h2>
              <p className="mt-1 text-ui text-fg-2">
                <span className="tnum font-semibold text-fg">{result.results.length}</span> checked
                {result.failed.length > 0 ? (
                  <>
                    , <span className="tnum font-semibold text-fail">{result.failed.length}</span> refused
                  </>
                ) : null}
                {result.planBlocked.length > 0 ? (
                  <>
                    , <span className="tnum font-semibold text-warn">{result.planBlocked.length}</span> over the plan limit
                  </>
                ) : null}
                .
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {zoneRecords.length > 0 ? (
                <span data-copy-scope className="inline-flex items-center gap-1">
                  <CopyButton
                    value={zone}
                    label="Copy all generated records as zone file lines"
                    testId="switch-copy-zone"
                  />
                  <pre data-copy-value className="sr-only">
                    {zone}
                  </pre>
                </span>
              ) : null}
              <Button
                variant="secondary"
                size="sm"
                onClick={checkAll}
                busy={checking}
                busyLabel="Checking DNS"
                disabled={!clientId}
                data-testid="switch-check-all"
              >
                Check all now
              </Button>
            </div>
          </div>

          <ActionRefusal error={checkError} />

          {result.results.length === 0 ? (
            <p className="border-y border-rule py-8 text-body text-fg-3">
              No domain produced a plan. The refusals below say why each row was skipped.
            </p>
          ) : (
            <Table caption="Domains and the records to publish" minWidth={1_040}>
              <THead>
                <tr>
                  <Th>Domain</Th>
                  <Th>Created or existing</Th>
                  <Th>Lookup outcome</Th>
                  <Th>Incumbent</Th>
                  <Th>Warnings</Th>
                  <Th>Record to publish</Th>
                </tr>
              </THead>
              <TBody>
                {result.results.map((row) => (
                  <ResultRow
                    key={`${row.index}-${row.domainId}`}
                    row={row}
                    check={checkedByDomain.get(row.domainId)}
                    dmarcProvesOwnership={result.ownershipNote !== null}
                  />
                ))}
              </TBody>
            </Table>
          )}

          {otherChecked.length > 0 ? (
            <div className="flex flex-col gap-2 border-t border-rule pt-4">
              <p className="legend">Other switches in this client, checked now</p>
              <Table caption="Other domain switches checked" dense>
                <THead>
                  <tr>
                    <Th>Domain</Th>
                    <Th>Status</Th>
                    <Th>Result</Th>
                    <Th>Issues</Th>
                  </tr>
                </THead>
                <TBody>
                  {otherChecked.map((row) => (
                    <Tr key={row.domainId} data-testid={`switch-check-other-${row.domainId}`}>
                      <Td mono className="font-semibold">
                        {row.name}
                      </Td>
                      <Td>
                        <Badge tone={SWITCH_STATUS[row.status].tone}>{SWITCH_STATUS[row.status].label}</Badge>
                      </Td>
                      <Td muted>{row.throttled ? "Checked recently" : transitionLabel(row.transitioned)}</Td>
                      <Td muted>{row.issues.length > 0 ? row.issues.map((issue) => issue.message).join(" ") : <Nil label="none" />}</Td>
                    </Tr>
                  ))}
                </TBody>
              </Table>
            </div>
          ) : null}

          {result.failed.length > 0 ? (
            <div>
              <p className="legend pb-1">Refused</p>
              <ul className="flex flex-col gap-1 text-meta" data-testid="switch-failed">
                {result.failed.map((failure) => (
                  <li key={`${failure.index}-${failure.name}`}>
                    <span className="data font-semibold text-fg">{failure.name}</span>{" "}
                    <span className="text-fg-3">{failure.reason}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {result.planBlocked.length > 0 ? (
            <Notice
              tone="warn"
              title={`${result.planBlocked.length} not planned: the plan's domain allowance is reached`}
              action={
                <ButtonLink href="/billing" size="sm">
                  See plan options
                </ButtonLink>
              }
            >
              <span className="data">{result.planBlocked.map((failure) => failure.name).join(", ")}</span>
            </Notice>
          ) : null}

          <p className="text-meta text-fg-3">
            The record text is generated from the live DNS record and keeps every other tag exactly as published. Add
            our address next to the incumbent&rsquo;s, wait for reports to arrive steadily, then publish the cutover
            record from each domain&rsquo;s page.
          </p>
        </section>
      ) : null}
    </div>
  );
}

function ResultRow({
  row,
  check,
  dmarcProvesOwnership,
}: {
  row: SwitchKitResultRow;
  check: SwitchCheckRow | undefined;
  /** Only a personal report address in the DMARC record proves ownership. */
  dmarcProvesOwnership: boolean;
}) {
  const warnings = row.plan.warnings.filter((warning) => warning.code !== "authorization_missing");
  const records: PublishRecord[] = [];
  if (row.verification) {
    records.push({
      purpose: dmarcProvesOwnership ? "Ownership proof (alternative)" : "Ownership proof",
      host: row.verification.host,
      value: row.verification.value,
      note: dmarcProvesOwnership
        ? "You can use either this TXT record or the DMARC record below to prove ownership."
        : "Publish this TXT record to prove the domain is managed by this workspace.",
    });
  }
  if (row.plan.record) {
    records.push({ purpose: "DMARC record", host: row.plan.record.host, value: row.plan.record.value });
  }

  return (
    <Tr data-testid={`switch-result-row-${row.domainId}`}>
      <Td>
        <Link href={domainHref(row.slug)} className="data font-semibold text-fg hover:text-act hover:underline">
          {row.name}
        </Link>
        <span className="mt-0.5 block text-meta text-fg-3">
          {row.plan.alreadyReportingToUs ? "Our address is already in rua" : row.plan.cname ? "Hosted behind a CNAME" : " "}
        </span>
        {check ? (
          <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-meta" data-testid={`switch-check-result-${row.domainId}`}>
            <Badge tone={SWITCH_STATUS[check.status].tone}>{SWITCH_STATUS[check.status].label}</Badge>
            <span className="text-fg-3">{check.throttled ? "Checked recently" : transitionLabel(check.transitioned)}</span>
            {check.issues.length > 0 ? (
              <span className="text-warn">{check.issues.map((issue) => issue.message).join(" ")}</span>
            ) : null}
          </span>
        ) : null}
      </Td>
      <Td>
        <Badge tone={row.created ? "neutral" : "accent"}>{row.created ? "Created" : "Existing"}</Badge>
      </Td>
      <Td>
        <span className="text-ui text-fg">{LOOKUP_LABEL[row.plan.lookup] ?? row.plan.lookup}</span>
        {row.plan.message && row.plan.lookup !== "found" ? (
          <span className="mt-0.5 block text-meta text-fg-3">{row.plan.message}</span>
        ) : null}
      </Td>
      <Td>
        {row.plan.primaryIncumbent ? (
          <>
            <span className="text-ui font-semibold text-fg">{row.plan.primaryIncumbent.label}</span>
            <span className="mt-0.5 block text-meta text-fg-3">
              {row.plan.incumbents.length === 1
                ? "1 report address"
                : `${row.plan.incumbents.length} report addresses`}
            </span>
          </>
        ) : (
          <Nil label="none found" />
        )}
      </Td>
      <Td>
        {warnings.length > 0 ? (
          <ul className="flex max-w-[280px] flex-col gap-1 text-meta text-fg-2">
            {warnings.map((warning) => (
              <li key={warning.code}>{warning.message}</li>
            ))}
          </ul>
        ) : (
          <Nil label="none" />
        )}
      </Td>
      <Td>
        {records.length > 0 ? (
          <details data-testid={`switch-records-${row.domainId}`}>
            <summary className="link cursor-pointer text-meta font-semibold" data-testid={`switch-records-toggle-${row.domainId}`}>
              Show {records.length} record{records.length === 1 ? "" : "s"}
            </summary>
            <div className="mt-3 min-w-[460px]">
              <DnsHandoff domain={row.name} records={records} />
            </div>
          </details>
        ) : (
          <span className="text-meta text-fg-3">{row.plan.message ?? "No record to publish."}</span>
        )}
      </Td>
    </Tr>
  );
}

function transitionLabel(transition: SwitchCheckRow["transitioned"]): string {
  if (transition === "started") return "Dual reporting started";
  if (transition === "cut_over") return "Cut over";
  return "No change";
}
