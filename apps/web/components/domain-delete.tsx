"use client";

/**
 * domain-delete.tsx — removing a domain, from its own setup page.
 *
 * The most destructive control in the product. A domain carries every DMARC
 * report, forensic report, scan, alert rule, alert event, share link and digest
 * produced for it, and the schema cascades all of it. That is evidence a
 * customer paid to produce and cannot be recovered.
 *
 * The consequence line says so in words rather than with a count, because there
 * is no per-domain count endpoint and a number read from the workspace total
 * would be a lie: the workspace holds every other client's domains too. Saying
 * what goes honestly is better than saying a wrong number.
 */

import { useRouter } from "next/navigation";
import { ConfirmAction } from "@/components/confirm-action";
import { deleteDomain } from "@/lib/ops-client";

export function DomainDelete({
  organizationId,
  domainId,
  domainName,
}: {
  organizationId: string;
  domainId: string;
  domainName: string;
}) {
  const router = useRouter();

  async function run() {
    const res = await deleteDomain(organizationId, domainId);
    if (!res.ok) {
      return { ok: false, message: res.error?.message };
    }
    // Back to the clients list, because the domain this page describes no
    // longer exists. Refreshing in place would render a page about nothing.
    router.push("/clients");
    router.refresh();
    return { ok: true };
  }

  return (
    <ConfirmAction
      label="delete this domain"
      confirmLabel={`delete ${domainName}`}
      consequence={`removes ${domainName} along with every report, forensic report, scan, alert rule, alert event, share link and digest attached to it. This cannot be undone.`}
      onConfirm={run}
      testId="delete-domain"
    />
  );
}
