import type { Metadata } from "next";
import { getReportInbox, OpsError } from "@/lib/api-ops";
import { instantLabel } from "@/lib/instant";
import { settingsContext } from "@/lib/settings-context";
import { mayChange } from "@/lib/settings-map";
import type { ReportInboxSettings } from "@/lib/types";
import { SettingsFrame } from "@/components/harbor/settings/frame";
import { MailboxBoard, RuaThread } from "@/components/harbor/settings/mailbox";
import { ErrorState, PermissionState, UpgradeNotice } from "@/components/ui/states";

export const metadata: Metadata = { title: "Report mailbox" };

type Read =
  | { kind: "ok"; inbox: ReportInboxSettings }
  | { kind: "plan"; message: string | null; feature: string }
  | { kind: "forbidden" }
  | { kind: "failed" };

/** /settings/mailbox — gated on reports.inbox at the read itself. */
export default async function MailboxPage() {
  const ctx = await settingsContext();
  const read: Read = await getReportInbox(ctx.active.id)
    .then((inbox): Read => ({ kind: "ok", inbox }))
    .catch((e: unknown): Read => {
      if (e instanceof OpsError && e.status === 402) return { kind: "plan", message: e.body?.message ?? null, feature: e.feature ?? "reports.inbox" };
      if (e instanceof OpsError && e.status === 403) return { kind: "forbidden" };
      return { kind: "failed" };
    });

  return (
    <SettingsFrame ctx={ctx} section="mailbox">
      <RuaThread />
      {read.kind === "ok" ? (
        <MailboxBoard
          organizationId={ctx.active.id}
          inbox={read.inbox}
          canManage={ctx.role === null ? true : mayChange(ctx.role, "admin")}
          lastPolledLabel={read.inbox.lastPolledAt ? instantLabel(read.inbox.lastPolledAt) : null}
        />
      ) : read.kind === "plan" ? (
        <UpgradeNotice
          message={read.message ?? "Collecting reports from your own mailbox is not included in this workspace's plan."}
          feature={read.feature}
          context="Reports sent to the addresses on each domain's setup page are collected on every plan. The API accepts mailbox ports 993, 143 and 2525 once it is included."
        />
      ) : read.kind === "forbidden" ? (
        <PermissionState what="the report mailbox" back={{ label: "All settings", href: "/settings" }} />
      ) : (
        <ErrorState what="the report mailbox" detail="Nothing was changed. Retry to read it." />
      )}
    </SettingsFrame>
  );
}
