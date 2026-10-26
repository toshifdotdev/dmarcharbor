import type {
  MailboxCheck,
  MailboxCheckStatus,
  MailboxComplianceView,
  MailboxProviderId,
} from "@/lib/types";
import { Badge, type Tone } from "@/components/ui/badge";
import { Readout, ReadoutStrip } from "@/components/ui/readout";
import { Nil, Table, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import { ErrorState } from "@/components/ui/states";

const STATUS: Record<MailboxCheckStatus, { tone: Tone; label: string }> = {
  meets: { tone: "ok", label: "Meets" },
  fails: { tone: "fail", label: "Does not meet" },
  unconfirmed: { tone: "warn", label: "Not confirmed" },
  not_measured: { tone: "neutral", label: "Not measured" },
  not_checkable: { tone: "neutral", label: "Check in the provider's tools" },
};

const GROUPS: Array<{ id: MailboxCheck["group"]; heading: string }> = [
  { id: "every_sender", heading: "Required of every sender" },
  { id: "bulk", heading: "Required at 5,000 a day" },
  { id: "recommended", heading: "Recommended" },
];

const PROVIDER_SHORT: Record<MailboxProviderId, string> = {
  google: "Google",
  yahoo: "Yahoo",
  microsoft: "Microsoft",
};

function dayLabel(value: string): string {
  return new Date(`${value}T00:00:00.000Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

function instantDay(value: string): string {
  return new Date(value).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function volume(value: number): string {
  return value.toLocaleString("en-GB");
}

function peakLine(provider: MailboxComplianceView["providers"][number]): string {
  if (provider.reportCount === 0) {
    return `No report from ${provider.name} in 30 days`;
  }
  if (provider.bulkThreshold === null) {
    return provider.bulkThresholdRule;
  }
  if (provider.aboveBulkThreshold === true && provider.peakDay) {
    return `Above ${provider.name}’s 5,000 a day on ${dayLabel(provider.peakDay)}`;
  }
  if (provider.aboveBulkThreshold === false) {
    return `Below ${provider.name}’s 5,000 a day`;
  }
  return `No qualifying daily report to compare with ${provider.name}’s 5,000 a day`;
}

function ProviderMarkers({ check }: { check: MailboxCheck }) {
  return (
    <span className="flex flex-wrap items-center gap-2">
      {check.requiredBy.map((entry) => (
        <a
          key={`${entry.provider}-${entry.level}`}
          href={entry.source}
          target="_blank"
          rel="noreferrer"
          className="link text-meta font-semibold"
          title={`${PROVIDER_SHORT[entry.provider]} · ${
            entry.level === "every_sender" ? "every sender" : entry.level === "bulk" ? "bulk senders" : "recommended"
          }`}
        >
          {PROVIDER_SHORT[entry.provider]}
        </a>
      ))}
    </span>
  );
}

function PerProviderTable({ check }: { check: MailboxCheck }) {
  if (!check.perProvider) {
    return null;
  }

  return (
    <div className="mt-3 flex flex-col gap-3">
      <Table caption={`${check.title} by provider`} minWidth={720} dense>
        <THead>
          <tr>
            <Th>Provider</Th>
            <Th numeric>Messages</Th>
            <Th numeric>Failing</Th>
            <Th numeric>Share</Th>
            <Th>Failing senders</Th>
          </tr>
        </THead>
        <TBody>
          {check.perProvider.map((entry) => (
            <Tr key={entry.provider}>
              <Td className="font-semibold">{PROVIDER_SHORT[entry.provider]}</Td>
              <Td numeric>{volume(entry.messages)}</Td>
              <Td numeric className={entry.failingMessages > 0 ? "font-semibold text-fail" : "text-fg-3"}>
                {volume(entry.failingMessages)}
              </Td>
              <Td numeric muted={entry.failingSharePercent === null}>
                {entry.failingSharePercent === null ? <Nil /> : `${entry.failingSharePercent}%`}
              </Td>
              <Td>
                {entry.failingSenders.length === 0 ? (
                  <span className="text-meta text-fg-3">{entry.note ?? "None above 5%."}</span>
                ) : (
                  <ul className="flex flex-col gap-1 text-meta">
                    {entry.failingSenders.map((sender) => (
                      <li key={sender.senderKey}>
                        <span className="data font-semibold text-fg">{sender.label}</span>
                        <span className="text-fg-2">
                          {" "}
                          {volume(sender.failingMessages)} of {volume(sender.messages)} failed ({sender.failingSharePercent}%)
                        </span>
                        {sender.sourceIps.length > 0 ? (
                          <span className="block text-fg-3">{sender.sourceIps.join(", ")}</span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </Td>
            </Tr>
          ))}
        </TBody>
      </Table>
    </div>
  );
}

function CheckRow({ check }: { check: MailboxCheck }) {
  const status = STATUS[check.status];
  return (
    <div data-testid={`mailbox-check-${check.code}`} className="grid gap-3 border-b border-rule py-4 md:grid-cols-[minmax(0,1fr)_170px] md:gap-6">
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h4 className="text-body font-semibold text-fg">{check.title}</h4>
          <ProviderMarkers check={check} />
        </div>
        <p className="mt-1 max-w-[80ch] text-ui text-fg-2">{check.summary}</p>
        <details data-testid={`mailbox-check-detail-${check.code}`} className="mt-2">
          <summary className="link cursor-pointer text-meta font-semibold">Evidence and fix</summary>
          <div className="mt-2 flex flex-col gap-2 border-l border-rule pl-3 text-meta text-fg-2">
            {check.evidence.length > 0 ? (
              <ul className="flex flex-col gap-1">
                {check.evidence.map((line) => (
                  <li key={line} className="data break-all">
                    {line}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-fg-3">
                {check.status === "not_checkable"
                  ? "This cannot be seen in DNS or DMARC reports."
                  : "No evidence was recorded for this check."}
              </p>
            )}
            {check.fix ? (
              <p>
                <span className="font-semibold text-fg">Fix: </span>
                {check.fix}
              </p>
            ) : null}
            {check.whereToCheck.length > 0 ? (
              <ul className="flex flex-wrap gap-x-4 gap-y-1">
                {check.whereToCheck.map((link) => (
                  <li key={link.url}>
                    <a href={link.url} target="_blank" rel="noreferrer" className="link">
                      {link.label}
                    </a>
                  </li>
                ))}
              </ul>
            ) : null}
            <PerProviderTable check={check} />
          </div>
        </details>
      </div>
      <div className="md:text-right">
        <span data-testid={`mailbox-check-status-${check.code}`}>
          <Badge tone={status.tone}>{status.label}</Badge>
        </span>
      </div>
    </div>
  );
}

function ProviderStrip({ view }: { view: MailboxComplianceView }) {
  return (
    <div className="flex flex-col gap-2">
      <ReadoutStrip>
        {view.providers.map((provider) => (
          <div key={provider.id} data-testid={`mailbox-provider-${provider.id}`}>
            <Readout
              label={provider.name}
              value={volume(provider.messages)}
              unit="messages"
              note={
                <>
                  <span className="block">{provider.covers}</span>
                  <span className="mt-1 block">
                    {provider.peakDailyMessages === null || provider.peakDay === null
                      ? "No qualifying daily peak."
                      : `Peak ${volume(provider.peakDailyMessages)} on ${dayLabel(provider.peakDay)}.`}
                  </span>
                  <span className="mt-1 block">{peakLine(provider)}</span>
                </>
              }
            />
          </div>
        ))}
      </ReadoutStrip>
      <p className="text-meta text-fg-3">
        Volumes include business mailboxes, so they can be higher than what the provider counts toward its threshold.
      </p>
    </div>
  );
}

export function MailboxCompliance({
  data,
  failed,
}: {
  data: MailboxComplianceView | null;
  failed: boolean;
}) {
  if (failed || !data) {
    return (
      <div data-testid="mailbox-load-failed">
        <ErrorState
          what="the Gmail, Yahoo and Outlook requirements"
          detail="The evidence could not be read. This is not the same as no requirement being met."
        />
      </div>
    );
  }

  const checkable = data.checks.length - data.counts.notCheckable;
  const scanLine = data.scan
    ? `The scan is from ${instantDay(data.scan.completedAt)}, and reports cover the last 30 days.`
    : "No completed DNS scan is on record yet. Report checks still use aggregate reports from the last 30 days.";

  return (
    <div className="flex flex-col gap-6 pt-4" data-testid="mailbox-panel">
      <p className="max-w-[80ch] text-body text-fg" data-testid="mailbox-summary">
        Meets <span className="tnum font-semibold">{data.counts.meets}</span> of the{" "}
        <span className="tnum font-semibold">{checkable}</span> requirements DMARC Harbor can check for this domain.{" "}
        <span className="tnum font-semibold">{data.counts.notCheckable}</span> more can only be checked in the providers’
        own tools. {scanLine}
      </p>

      <ProviderStrip view={data} />

      {GROUPS.map((group) => {
        const checks = data.checks.filter((check) => check.group === group.id);
        if (checks.length === 0) return null;
        return (
          <section key={group.id} aria-labelledby={`mailbox-group-${group.id}`} className="flex flex-col">
            <h3 id={`mailbox-group-${group.id}`} className="legend border-b border-rule pb-2">
              {group.heading}
            </h3>
            {checks.map((check) => (
              <CheckRow key={check.code} check={check} />
            ))}
          </section>
        );
      })}

      <p className="max-w-[80ch] text-meta text-fg-3">
        “Does not meet” for a sender means more than {data.thresholds.maximumFailureSharePercent}% of its messages failed
        in the last 30 days. That threshold is DMARC Harbor’s, not the provider’s; forwarding can break SPF on legitimate
        mail, which is why it is not 0%.
        {data.rowsTruncated
          ? " The report read reached the 50,000-record cap, so these figures cover the newest records only."
          : ""}
      </p>
    </div>
  );
}
