"use client";

/**
 * domain-move.tsx — moving a domain to another client.
 *
 * Used from the client book (a "Move" on each domain row) and from the
 * domain's setup page. An MSP files a domain under the wrong client, or a
 * client sells a brand to another: before this the fix was deleting the domain
 * and its evidence and adding it again.
 *
 * The confirmation is built from the API's own preview, so it says exactly
 * what goes with the domain (its reports, scans, alerts, digests and share
 * links, all unchanged) and what changes hands: which portal contacts stop and
 * start seeing it, the approval requests that are withdrawn, where the next
 * monthly report and PSA ticket go, and whether the DMARC record in DNS still
 * names the previous client's report address. A move can be undone by moving
 * it back, so it is a primary action, not a red one.
 *
 * Test hooks: move-domain-confirm (the open dialog), move-domain-target,
 * move-domain-confirm-button, move-domain-error.
 */

import { useRouter } from "next/navigation";
import { useEffect, useId, useState } from "react";
import { moveDomain, previewDomainMove, type DomainMovePreview, type DomainMoveResult } from "@/lib/ops-client";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy";
import { Dialog } from "@/components/ui/dialog";
import { Select } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";

export interface MoveTarget {
  id: string;
  name: string;
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function listNames(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** The sentence a notice shows after a move, built from the API's answer. */
export function movedLine(result: DomainMoveResult): string {
  const parts = [`${result.domain.name} is now under ${result.to.name}, with its reports, scans, alerts and digests.`];
  if (result.shareLinksMoved > 0) parts.push(`${count(result.shareLinksMoved, "share link", "share links")} moved with it.`);
  if (result.withdrawnProposals > 0) {
    parts.push(`${count(result.withdrawnProposals, "approval request", "approval requests")} to ${result.from.name} withdrawn.`);
  }
  if (result.reportAddress.recordNamesPrevious) {
    parts.push(`Change the rua address in its DMARC record to ${result.reportAddress.next}.`);
  }
  return parts.join(" ");
}

export function MoveDomainDialog({
  organizationId,
  domain,
  from,
  clients,
  onClose,
  onMoved,
}: {
  organizationId: string;
  /** The domain to move; the dialog is open while this is set. */
  domain: { id: string; name: string } | null;
  /** The client it is under now. */
  from: MoveTarget;
  /** Every client in the workspace; the current one is left out of the choice. */
  clients: MoveTarget[];
  onClose: () => void;
  onMoved: (result: DomainMoveResult) => void;
}) {
  const router = useRouter();
  const selectId = useId();
  const choices = clients.filter((c) => c.id !== from.id);
  const [shownFor, setShownFor] = useState<string | null>(null);
  const [target, setTarget] = useState("");
  const [preview, setPreview] = useState<{ for: string; data: DomainMovePreview | null; error: string | null } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A fresh dialog per domain: the first other client chosen, nothing read yet.
  if (domain && domain.id !== shownFor) {
    setShownFor(domain.id);
    setTarget(choices[0]?.id ?? "");
    setPreview(null);
    setError(null);
  }
  if (!domain && shownFor !== null) {
    setShownFor(null);
  }

  const domainId = domain?.id ?? null;
  useEffect(() => {
    if (!domainId || !target) return;
    let active = true;
    previewDomainMove(organizationId, domainId, target)
      .then((res) => {
        if (!active) return;
        setPreview({
          for: target,
          data: res.ok ? res.data : null,
          error: res.ok ? null : (res.error.message ?? "What moves with it could not be read."),
        });
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [organizationId, domainId, target]);

  const current = preview && preview.for === target ? preview : null;
  const data = current?.data ?? null;
  const toName = choices.find((c) => c.id === target)?.name ?? "the other client";
  const blocked = (data?.blockers.length ?? 0) > 0;
  const canMove = Boolean(domain && data && !blocked && !data.alreadyThere && !busy);

  async function run() {
    if (!domain || !canMove) return;
    setBusy(true);
    setError(null);
    const res = await moveDomain(organizationId, domain.id, target);
    setBusy(false);
    if (!res.ok) {
      // A refusal's blockers are already sentences in the message.
      setError(res.error.message ?? "The domain could not be moved. Nothing changed.");
      return;
    }
    onMoved(res.data);
    router.refresh();
  }

  return (
    <Dialog
      open={domain !== null}
      onClose={busy ? () => {} : onClose}
      title={domain ? `Move ${domain.name} to another client?` : ""}
      testId="move-domain-confirm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={run}
            disabled={!canMove}
            busy={busy}
            busyLabel="Moving"
            data-testid="move-domain-confirm-button"
          >
            Move to {toName}
          </Button>
        </>
      }
    >
      {domain ? (
        choices.length === 0 ? (
          <p className="text-body text-fg-2">
            There is no other client to move it to. Add the client on the Clients page first, then move the domain.
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label htmlFor={selectId} className="text-meta font-semibold text-fg-2">
                Move from <span className="text-fg">{from.name}</span> to
              </label>
              <Select
                id={selectId}
                size="lg"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                data-testid="move-domain-target"
              >
                {choices.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </div>

            {current === null ? (
              <p className="text-ui text-fg-3" role="status">
                Reading what moves with it.
              </p>
            ) : current.error || !data ? (
              <Notice tone="fail" title={current.error ?? "What moves with it could not be read."}>
                Nothing has changed. Close this and try again.
              </Notice>
            ) : (
              <MovePreview preview={data} domainName={domain.name} />
            )}

            {error ? (
              <div role="alert" data-testid="move-domain-error" className="text-ui text-fail">
                <p className="font-semibold">{error}</p>
              </div>
            ) : null}
          </div>
        )
      ) : null}
    </Dialog>
  );
}

function MovePreview({ preview: p, domainName }: { preview: DomainMovePreview; domainName: string }) {
  if (p.blockers.length > 0) {
    return (
      <Notice tone="fail" title="This domain cannot be moved yet" role="alert">
        <ul className="mt-1 flex list-disc flex-col gap-1 pl-5">
          {p.blockers.map((b) => (
            <li key={b.code}>{b.message}</li>
          ))}
        </ul>
      </Notice>
    );
  }

  const m = p.moves;
  const travelling = (
    [
      [m.dmarcReports, "aggregate report", "aggregate reports"],
      [m.forensicReports, "forensic report", "forensic reports"],
      [m.scans, "DNS scan", "DNS scans"],
      [m.alertRules, "alert rule", "alert rules"],
      [m.openAlerts, "open alert", "open alerts"],
      [m.reportDigests, "digest", "digests"],
      [m.liveShareLinks, "live share link", "live share links"],
    ] as Array<[number, string, string]>
  )
    .filter(([n]) => n > 0)
    .map(([n, one, many]) => count(n, one, many));

  const changes: string[] = [];
  if (p.portal.losingContacts > 0) {
    changes.push(
      `${p.from.name}'s ${count(p.portal.losingContacts, "portal contact stops", "portal contacts stop")} seeing it.`,
    );
  }
  if (p.portal.gainingContacts > 0) {
    changes.push(
      `${p.to.name}'s ${count(p.portal.gainingContacts, "portal contact starts", "portal contacts start")} seeing it.`,
    );
  }
  if (p.pendingProposals > 0) {
    changes.push(
      `${count(p.pendingProposals, "approval request", "approval requests")} waiting on ${p.from.name} ${
        p.pendingProposals === 1 ? "is" : "are"
      } withdrawn. Ask ${p.to.name} again from the domain page.`,
    );
  }
  if (m.liveShareLinks > 0) {
    changes.push(`Live share links keep working and now name ${p.to.name}.`);
  }
  changes.push(
    `Monthly reports already issued stay with ${p.from.name}. From the next one, the domain is in ${p.to.name}'s report${
      p.monthlyReports.toScheduled ? "" : `; ${p.to.name} has no monthly schedule yet`
    }.`,
  );
  if (p.psa.fromCompany || p.psa.toCompany || p.psa.openTickets > 0) {
    changes.push(
      `${p.psa.openTickets > 0 ? `${count(p.psa.openTickets, "open PSA ticket stays", "open PSA tickets stay")} where ${p.psa.openTickets === 1 ? "it is" : "they are"}. ` : ""}New tickets go to ${
        p.psa.toCompany ?? `no PSA company until ${p.to.name} is mapped to one`
      }.`,
    );
  }

  return (
    <div className="flex flex-col gap-4 text-ui text-fg-2">
      <div>
        <p className="font-semibold text-fg">Moves with it, unchanged</p>
        <p className="mt-0.5">
          {travelling.length > 0 ? `${listNames(travelling)}.` : "Nothing else is attached to it yet."} The domain keeps its
          name, its setup page and its history.
        </p>
      </div>

      <div>
        <p className="font-semibold text-fg">Changes hands</p>
        <ul className="mt-0.5 flex list-disc flex-col gap-1 pl-5">
          {changes.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </div>

      {p.digestRecipients.length > 0 ? (
        <div>
          <p className="font-semibold text-fg">Digests keep their recipients</p>
          <p className="mt-0.5">
            They still go to <span className="data text-fg">{listNames(p.digestRecipients.slice(0, 6))}</span>
            {p.digestRecipients.length > 6 ? ` and ${p.digestRecipients.length - 6} more` : ""}. Change them on Digests if
            those people work for {p.from.name}.
          </p>
        </div>
      ) : null}

      {p.reportAddress.recordNamesPrevious ? (
        <Notice tone="warn" title={`The DMARC record still names ${p.from.name}'s report address`}>
          <p>
            Reports keep arriving, because they are matched to {domainName} by name. But the record stops proving that{" "}
            {p.to.name} owns the domain, so unless the ownership TXT record is published, the daily ownership check can
            lapse.
            {p.reportAddress.hosted
              ? " It is a hosted DMARC record, which keeps the address it was created with."
              : " Replace the rua address with this one:"}
          </p>
          {p.reportAddress.hosted ? null : (
            <p data-copy-scope className="mt-2 flex flex-wrap items-center gap-2">
              <code data-copy-value className="data break-all text-fg">
                {p.reportAddress.next}
              </code>
              <CopyButton value={p.reportAddress.next} label={`Copy ${p.to.name}'s report address`} />
            </p>
          )}
        </Notice>
      ) : null}
    </div>
  );
}

/**
 * The setup page's own section: a button that opens the move dialog, and the
 * outcome once it is done.
 */
export function DomainMove({
  organizationId,
  domain,
  from,
  clients,
}: {
  organizationId: string;
  domain: { id: string; name: string };
  from: MoveTarget;
  clients: MoveTarget[];
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  return (
    <section aria-labelledby={`${id}-head`} className="flex flex-col gap-4 border-t border-rule pt-6">
      <div>
        <h2 id={`${id}-head`} className="text-h3 font-bold tracking-[-0.01em] text-fg">
          Move to another client
        </h2>
        <p className="mt-1 max-w-[68ch] text-ui text-fg-2">
          For a domain filed under the wrong client, or one that changed hands. Its reports, scans, alerts, digests and
          share links go with it; you see exactly what changes before anything does, and you can move it back.
        </p>
      </div>
      {done ? (
        <Notice tone="ok" title="Domain moved">
          {done}
        </Notice>
      ) : null}
      <Button
        variant="secondary"
        className="self-start"
        data-testid="move-domain"
        onClick={() => {
          setDone(null);
          setOpen(true);
        }}
      >
        Move {domain.name}
      </Button>
      <MoveDomainDialog
        organizationId={organizationId}
        domain={open ? domain : null}
        from={from}
        clients={clients}
        onClose={() => setOpen(false)}
        onMoved={(result) => {
          setOpen(false);
          setDone(movedLine(result));
        }}
      />
    </section>
  );
}
