import type { Metadata } from "next";
import Link from "next/link";
import { listClients } from "@/lib/api";
import { getDpaAcceptance, getWorkspaceEntitlements } from "@/lib/api-ops";
import { settingsContext } from "@/lib/settings-context";
import { SettingsFrame } from "@/components/harbor/settings/frame";
import { Panel } from "@/components/harbor/settings/parts";
import { WorkspaceDeletion } from "@/components/harbor/settings/workspace";
import { CopyValue } from "@/components/ui/copy";
import { KeyValue } from "@/components/ui/notice";

export const metadata: Metadata = { title: "Workspace" };

/**
 * /settings/workspace — what this workspace is, and deleting it.
 *
 * Read-only facts first (the API offers no rename route of its own, so none is
 * offered here), then the one destructive control, set apart.
 */
export default async function WorkspacePage() {
  const ctx = await settingsContext();
  const [entitlements, clients, dpa] = await Promise.all([
    getWorkspaceEntitlements(ctx.active.id).catch(() => null),
    listClients(ctx.active.id).catch(() => null),
    getDpaAcceptance(ctx.active.id).catch(() => null),
  ]);
  const domains = clients ? clients.reduce((n, c) => n + c.domains.length, 0) : null;
  const unread = <span className="text-fg-3">could not be read</span>;

  return (
    <SettingsFrame
      ctx={ctx}
      section="workspace"
      lede="The workspace holds its own clients, domains, people and plan. Nothing in it is shared with your other workspaces."
    >
      <Panel id="ws-facts" title="This workspace">
        <KeyValue
          labelWidth={200}
          rows={[
            ["Name", <span key="n" className="font-semibold">{ctx.active.name}</span>],
            ["Slug", <CopyValue key="s" value={ctx.active.slug} label="workspace slug" className="max-w-[420px]" />],
            [
              "Workspace ID",
              <div key="i" className="max-w-[420px]">
                <CopyValue value={ctx.active.id} label="workspace ID" />
                <p className="mt-1 text-meta text-fg-3">Support asks for this. It is not a secret.</p>
              </div>,
            ],
            [
              "Plan",
              entitlements ? (
                <span key="p">
                  <span className="font-semibold">{entitlements.label}</span>{" "}
                  <Link href="/billing" className="link ml-2 text-meta">
                    Billing
                  </Link>
                </span>
              ) : (
                unread
              ),
            ],
            [
              "Holds",
              clients && domains !== null ? (
                <span key="h" className="tnum">
                  {clients.length} client{clients.length === 1 ? "" : "s"}, {domains} domain{domains === 1 ? "" : "s"}
                </span>
              ) : (
                unread
              ),
            ],
            [
              "People",
              ctx.members ? (
                <span key="m">
                  <span className="tnum">{ctx.members.length}</span> member{ctx.members.length === 1 ? "" : "s"}
                  <Link href="/settings/members" className="link ml-2 text-meta">
                    Members and roles
                  </Link>
                </span>
              ) : (
                unread
              ),
            ],
            ["Your role", ctx.role ? <span key="r" className="capitalize">{ctx.role}</span> : unread],
            [
              "Data Processing Agreement",
              dpa ? (
                <span key="d">
                  {dpa.accepted && dpa.version ? (
                    <>
                      Version <span className="data">{dpa.version}</span> accepted
                      {dpa.requiresReconsent ? (
                        <span className="ml-2 font-semibold text-warn">version {dpa.currentVersion} is current and needs accepting</span>
                      ) : (
                        <span className="ml-2 text-fg-3">the current version</span>
                      )}
                    </>
                  ) : (
                    <span className="font-semibold text-warn">Not accepted for this workspace</span>
                  )}
                  <Link href="/dpa" className="link ml-2 text-meta">
                    Read it
                  </Link>
                </span>
              ) : (
                unread
              ),
            ],
          ]}
        />
      </Panel>

      <WorkspaceDeletion
        organizationId={ctx.active.id}
        name={ctx.active.name}
        slug={ctx.active.slug}
        isOwner={ctx.role === null ? null : ctx.role === "owner"}
      />
    </SettingsFrame>
  );
}
