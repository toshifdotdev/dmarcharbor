"use client";

/**
 * client-row-actions.tsx — what can be done to one client from the list.
 *
 * A client component because deletion is a request with a confirm step: the two
 * presses, the live count and the error all need state. The row it sits on is
 * rendered by a server component that holds the list.
 *
 * The consequence line states what is KNOWN from the page already loaded - the
 * domain count, because the client list carries its domains - and does not
 * invent numbers for the reports and scans it cannot see. There is no
 * per-client count endpoint, and a confirm line that guesses is worse than one
 * that is honest about its limits.
 */

import { useRouter } from "next/navigation";
import { ConfirmAction } from "@/components/confirm-action";
import { deleteClient } from "@/lib/ops-client";
import type { ClientRow } from "@/lib/types";

function consequenceFor(client: ClientRow): string {
  const domains = client.domains.length;
  if (domains === 0) {
    return "removes the client. Nothing else is attached.";
  }
  return `removes the client, its ${domains} domain${domains === 1 ? "" : "s"} and every report, scan, alert rule and share link attached to them.`;
}

export function ClientRowActions({
  organizationId,
  client,
}: {
  organizationId: string;
  client: ClientRow;
}) {
  const router = useRouter();

  async function run() {
    const res = await deleteClient(organizationId, client.id);
    if (!res.ok) {
      // The API's own words, which name the reason: a portal grant still exists,
      // or the client is not in this workspace. Both are actionable.
      return { ok: false, message: res.error?.message };
    }
    // Re-read from the server: the row is gone, and removing it client-side
    // would leave the client count and the portfolio totals wrong.
    router.refresh();
    return { ok: true };
  }

  return (
    <div className="mt-2">
      <ConfirmAction
        label="delete client"
        confirmLabel={`delete ${client.name}`}
        consequence={consequenceFor(client)}
        onConfirm={run}
        testId="delete-client"
      />
    </div>
  );
}
