import type { Metadata } from "next";
import Link from "next/link";
import { listClients } from "@/lib/api";
import { getDpaAcceptance, getWorkspaceEntitlements } from "@/lib/api-ops";
import { settingsContext } from "@/lib/settings-context";
import { readHostBrand } from "@/lib/host-brand";
import { brandName } from "@/components/harbor/public-frame";
import { SettingsFrame } from "@/components/harbor/settings/frame";
import { Panel, StateWord } from "@/components/harbor/settings/parts";
import { WorkspaceDeletion, WorkspaceRename } from "@/components/harbor/settings/workspace";
import { mayChange } from "@/lib/settings-map";
import { CopyValue } from "@/components/ui/copy";
import { KeyValue } from "@/components/ui/notice";

export const metadata: Metadata = { title: "Workspace" };

/**
 * /settings/workspace — what this workspace is, renaming it, and deleting it.
 *
 * Facts first, then the rename (POST /workspaces/:id/rename, owner or admin,
 * audited; the slug and id stay), then the one destructive control, set apart.
 */
export default async function WorkspacePage() {
  const ctx = await settingsContext();
  const [entitlements, clients, dpa, hostBrand] = await Promise.all([
    getWorkspaceEntitlements(ctx.active.id).catch(() => null),
    listClients(ctx.active.id).catch(() => null),
    getDpaAcceptance(ctx.active.id).catch(() => null),
    readHostBrand(),
  ]);
  const domains = clients ? clients.reduce((n, c) => n + c.domains.length, 0) : null;
  const unread = (
    <StateWord shape="hatch" tone="void">
      Could not be read
    </StateWord>
  );

  return (
    <SettingsFrame
      ctx={ctx}
      section="workspace"
      lede="The workspace holds its own clients, domains, people and plan. Nothing in it is shared with your other workspaces."
    >
      <Panel id="ws-facts" title="This workspace">
        <KeyValue
          className="-mt-4 border-t-0!"
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
                <span key="d" className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  {dpa.accepted && dpa.version ? (
                    dpa.requiresReconsent ? (
                      <StateWord shape="ring" tone="warn">
                        Version {dpa.version} accepted; version {dpa.currentVersion} is current and needs accepting
                      </StateWord>
                    ) : (
                      <span className="inline-flex items-baseline gap-2">
                        <StateWord shape="square" tone="ok">
                          Accepted
                        </StateWord>
                        <span className="text-fg-2">
                          version <span className="data">{dpa.version}</span>, the current one
                        </span>
                      </span>
                    )
                  ) : (
                    <StateWord shape="ring" tone="warn">
                      Not accepted for this workspace
                    </StateWord>
                  )}
                  <Link href="/dpa" className="link text-meta">
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

      <Panel
        id="ws-rename"
        title="Rename the workspace"
        why="For an agency that changes its name. Clients, domains, links and the workspace ID are not affected."
      >
        <WorkspaceRename
          organizationId={ctx.active.id}
          name={ctx.active.name}
          canRename={ctx.role === null ? null : mayChange(ctx.role, "admin")}
        />
      </Panel>

      <WorkspaceDeletion
        organizationId={ctx.active.id}
        name={ctx.active.name}
        slug={ctx.active.slug}
        isOwner={ctx.role === null ? null : ctx.role === "owner"}
        serviceName={brandName(hostBrand)}
      />
    </SettingsFrame>
  );
}
