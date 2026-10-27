"use client";

/**
 * domain-removal.tsx — deleting a domain, from its own setup page.
 *
 * The most destructive control in the product. A domain carries every DMARC
 * report, forensic report, scan, alert rule, alert event, share link and digest
 * produced for it, and the schema cascades all of it. So the confirm asks for
 * the domain's name typed out: a reflex click on "Delete" in a dialog is not
 * enough for evidence that cannot come back.
 *
 * What goes is said in words, not as a count: there is no per-domain count
 * endpoint, and a workspace total would be a wrong number.
 */

import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { deleteDomain } from "@/lib/ops-client";
import { Button } from "@/components/ui/button";
import { DnsRecord } from "@/components/ui/copy";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/field";

export function DomainRemoval({
  organizationId,
  domainId,
  domainName,
  hosted,
  managedSpf,
}: {
  organizationId: string;
  domainId: string;
  domainName: string;
  /** The TXT DMARC Harbor serves for this domain, when it is hosted here. */
  hosted: { value: string } | null;
  /** The unflattened SPF record to republish, when SPF is managed here. */
  managedSpf: { value: string } | null;
}) {
  const router = useRouter();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const matches = typed.trim().toLowerCase() === domainName.toLowerCase();

  async function run() {
    if (!matches || busy) return;
    setBusy(true);
    setError(null);
    const res = await deleteDomain(organizationId, domainId);
    if (!res.ok) {
      setBusy(false);
      setError(res.error.message ?? "The domain could not be deleted.");
      return;
    }
    // The page describes a domain that no longer exists: leave it.
    router.push("/clients");
    router.refresh();
  }

  return (
    <section aria-labelledby={`${id}-head`} className="flex flex-col gap-3 border-t border-rule pt-5">
      <div>
        <h2 id={`${id}-head`} className="text-h3 font-bold tracking-[-0.01em] text-fg">
          Delete this domain
        </h2>
        <p className="mt-1 max-w-[68ch] text-ui text-fg-2">
          For a client who has left, or a domain that is retired. Deleting takes every report, forensic report, scan,
          alert, share link and digest for {domainName} with it, and cannot be undone. Export first if you need a copy.
        </p>
      </div>
      <Button
        variant="danger"
        className="self-start"
        data-testid="delete-domain"
        onClick={() => {
          setTyped("");
          setError(null);
          setOpen(true);
        }}
      >
        Delete {domainName}
      </Button>

      <Dialog
        open={open}
        onClose={() => (busy ? undefined : setOpen(false))}
        title={`Delete ${domainName}?`}
        testId="delete-domain-confirm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={run}
              disabled={!matches}
              busy={busy}
              busyLabel="Deleting"
              data-testid="delete-domain-confirm-button"
            >
              Delete the domain and its evidence
            </Button>
          </>
        }
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run();
          }}
          className="flex flex-col gap-3"
        >
          <p className="text-body text-fg-2">
            Every report, forensic report, scan, alert rule, alert event, share link and digest for this domain is
            deleted. Live share links stop working. This cannot be undone.
          </p>
          {hosted ? (
            <div className="border border-warn/40 bg-paper-2 p-3">
              <p className="font-semibold text-fg">
                This domain reads its DMARC record from DMARC Harbor. Publish this TXT at your DNS host and remove the
                CNAME first, or the domain will have no DMARC record once it is deleted here.
              </p>
              <DnsRecord type="TXT" host={`_dmarc.${domainName}`} zone={domainName} value={hosted.value} />
            </div>
          ) : null}
          {managedSpf ? (
            <div className="border border-warn/40 bg-paper-2 p-3">
              <p className="font-semibold text-fg">
                This domain&rsquo;s SPF record is managed by DMARC Harbor. Publish this TXT at your DNS host and remove
                the redirect to DMARC Harbor first, or the domain will lose its SPF record once it is deleted here.
              </p>
              <DnsRecord type="TXT" host={domainName} zone={domainName} value={managedSpf.value} />
            </div>
          ) : null}
          <label htmlFor={`${id}-confirm`} className="text-meta font-semibold text-fg-2">
            Type <span className="data text-fg">{domainName}</span> to confirm
          </label>
          <Input
            id={`${id}-confirm`}
            mono
            size="lg"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
          />
          {error ? (
            <p role="alert" className="text-ui font-medium text-fail">
              {error}
            </p>
          ) : null}
        </form>
      </Dialog>
    </section>
  );
}
