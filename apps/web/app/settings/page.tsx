import {
  getBranding,
  getReportInbox,
  getWorkspaceEntitlements,
  listSsoConnections,
  listWorkspaceMembers,
} from "@/lib/api-ops";
import Link from "next/link";
import { resolveActiveWorkspace } from "@/lib/session";
import type { WorkspaceMemberRow, SsoConnectionRow } from "@/lib/types";
import { Shell } from "@/components/shell";
import {
  ReportInboxForm,
  SsoSection,
  WhiteLabelForm,
} from "@/components/settings-client";

/**
 * Members are read-only here on purpose: inviting, role changes and offboarding
 * go through better-auth organization endpoints and are a separate surface.
 * Five roles exist — owner, admin, analyst, viewer, portal — and `portal` is a
 * client contact: it reads reports and nothing else (no forensic access, no
 * billing, no member management).
 */
const ROLE_BLURB: Record<string, string> = {
  owner: "full control, and the only role that can change the plan",
  admin: "day-to-day operation of the workspace",
  analyst: "measurement work; no forensic identities, no billing",
  viewer: "read-only",
  portal: "client contact — reads reports and nothing else",
};

export default async function SettingsPage() {
  const { workspaces, active } = await resolveActiveWorkspace();
  if (!active) return null;

  const entitlements = await getWorkspaceEntitlements(active.id).catch(() => null);
  const allowWhiteLabel = entitlements?.features["branding.whitelabel"] === true;
  const allowLogoUpload = entitlements?.features["branding.logoUpload"] === true;
  const allowSso = entitlements?.features["auth.sso"] === true;
  const allowInbox = entitlements?.features["reports.inbox"] === true;

  const [membersRes, branding, inbox, ssoRes] = await Promise.all([
    listWorkspaceMembers(active.id).catch(() => ({ members: [] as WorkspaceMemberRow[] })),
    getBranding(active.id).catch(() => null),
    getReportInbox(active.id).catch(() => null),
    allowSso
      ? listSsoConnections(active.id).catch(() => ({ connections: [] as SsoConnectionRow[] }))
      : Promise.resolve({ connections: [] as SsoConnectionRow[] }),
  ]);
  const members = membersRes.members ?? [];
  const connections = ssoRes.connections ?? [];

  return (
    <Shell workspaces={workspaces} activeWorkspace={active}>
      <div className="flex flex-col gap-5">
        <header>
          <h1 className="label">Settings</h1>
          <p className="mt-1.5 text-[14.5px]" style={{ color: "var(--color-ink-2)" }}>
            Workspace membership, client-facing branding, the shared report
            mailbox, and identity.
          </p>
        </header>

        <section
          className="lift rounded-[2px] border"
          style={{ background: "var(--color-surface)", borderColor: "var(--color-line)" }}
        >
          <header className="border-b px-5 py-3.5" style={{ borderColor: "var(--color-line)" }}>
            <h2 className="text-[16.5px] font-semibold tracking-[-0.012em]">Members</h2>
          </header>
          <ul>
            {members.map((m) => (
              <li
                key={m.id}
                className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b px-5 py-3"
                style={{ borderColor: "rgba(255,255,255,0.055)" }}
              >
                <div className="min-w-0 flex-1">
                  <div className="text-[14px]" style={{ color: "var(--color-ink)" }}>
                    {m.user?.name ?? m.user?.email ?? m.userId}
                  </div>
                  <div className="text-[12.5px]" style={{ color: "var(--color-ink-3)" }}>
                    {m.user?.email}
                  </div>
                </div>
                <div className="text-right">
                  <div
                    className="num text-[11.5px] tracking-[0.14em] uppercase"
                    style={{ color: "var(--color-accent)" }}
                  >
                    {m.role}
                  </div>
                  <div className="text-[12px]" style={{ color: "var(--color-ink-3)" }}>
                    {ROLE_BLURB[m.role] ?? ""}
                  </div>
                </div>
              </li>
            ))}
          </ul>

          {/* The role model, named in full: membership lists only show the roles
              people hold, so a role like `portal` would otherwise stay invisible
              exactly where someone needs to understand what it means. */}
          <div className="border-t px-5 py-4" style={{ borderColor: "var(--color-line)" }}>
            <div className="label">The five roles</div>
            <dl className="mt-2.5 grid grid-cols-1 gap-x-8 gap-y-1.5 sm:grid-cols-2">
              {Object.entries(ROLE_BLURB).map(([role, blurb]) => (
                <div key={role} className="flex items-baseline gap-2.5">
                  <dt
                    className="num text-[11.5px] tracking-[0.14em] uppercase"
                    style={{ color: "var(--color-ink-2)", minWidth: 64 }}
                  >
                    {role}
                  </dt>
                  <dd className="text-[12.5px]" style={{ color: "var(--color-ink-3)" }}>
                    {blurb}
                  </dd>
                </div>
              ))}
            </dl>
            <p className="mt-2.5 text-[12.5px]" style={{ color: "var(--color-ink-3)" }}>
              <strong style={{ color: "var(--color-ink-2)" }}>portal</strong> is a
              client contact, not agency staff: it reads reports and nothing else —
              no forensic access, no billing, no member management.
            </p>
          </div>
        </section>

        {branding ? (
          <WhiteLabelForm
            organizationId={active.id}
            branding={branding}
            allowLogoUpload={allowLogoUpload}
            allowWhiteLabel={allowWhiteLabel}
          />
        ) : null}

        {inbox ? (
          allowInbox ? (
            <ReportInboxForm organizationId={active.id} inbox={inbox} />
          ) : (
            <section
              className="lift rounded-[2px] border p-5"
              style={{ background: "var(--color-surface)", borderColor: "var(--color-line)" }}
              data-feature="reports.inbox"
            >
              <h2 className="text-[17.5px] font-semibold tracking-[-0.012em]">Report mailbox</h2>
              <p className="mt-2 text-[15px]" style={{ color: "var(--color-ink-2)" }}>
                The shared report mailbox is not included in your current plan.
              </p>
              <Link
                href="/billing"
                className="mt-2 inline-block text-[14.5px] font-semibold underline"
                style={{ color: "var(--color-ink)" }}
              >
                See plan options
              </Link>
            </section>
          )
        ) : null}

        {allowSso ? (
          <SsoSection organizationId={active.id} connections={connections} />
        ) : (
          <section
            className="lift rounded-[2px] border p-5"
            style={{ background: "var(--color-surface)", borderColor: "var(--color-line)" }}
            data-feature="auth.sso"
          >
            <h2 className="text-[17.5px] font-semibold tracking-[-0.012em]">Single sign-on</h2>
            <p className="mt-2 text-[15px]" style={{ color: "var(--color-ink-2)" }}>
              Single sign-on is not included in your current plan.
            </p>
            <Link
              href="/billing"
              className="mt-2 inline-block text-[14.5px] font-semibold underline"
              style={{ color: "var(--color-ink)" }}
            >
              See plan options
            </Link>
          </section>
        )}

        <section
          className="lift rounded-[2px] border p-5"
          style={{ background: "var(--color-surface)", borderColor: "var(--color-line)" }}
        >
          <h2 className="text-[16.5px] font-semibold tracking-[-0.012em]">
            Data-subject rights
          </h2>
          <p className="mt-2 text-[14px]" style={{ color: "var(--color-ink-2)" }}>
            Export and erasure of personal data are available on{" "}
            <strong style={{ color: "var(--color-ink)" }}>every plan</strong> at
            no cost. They are not a paid feature and never will be.
          </p>
        </section>
      </div>
    </Shell>
  );
}
