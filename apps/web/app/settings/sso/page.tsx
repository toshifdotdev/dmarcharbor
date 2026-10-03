import Link from "next/link";
import { getWorkspaceEntitlements, listSsoConnections } from "@/lib/api-ops";
import { resolveActiveWorkspace } from "@/lib/session";
import { Shell } from "@/components/shell";
import { SettingsNav } from "@/components/settings-nav";
import { SsoSection } from "@/components/settings-client";

/**
 * SSO connections — Admiralty only. The allowlist of verified email domains is
 * surfaced on every connection: a connection that silently refuses everyone
 * looks like a broken feature, so the list is never hidden in a drawer.
 *
 * GET /sso/:connectionId/start is what customers link from their identity
 * provider — the UI never fetches it.
 */
export default async function SsoSettingsPage() {
  const { workspaces, active } = await resolveActiveWorkspace();
  if (!active) return null;

  const [entitlements, ssoRes] = await Promise.all([
    getWorkspaceEntitlements(active.id).catch(() => null),
    listSsoConnections(active.id).catch(() => ({ connections: [] })),
  ]);
  const allowSso = entitlements?.features["auth.sso"] === true;

  return (
    <Shell workspaces={workspaces} activeWorkspace={active}>
      <div className="flex flex-col gap-5">
        <header>
          <h1 className="label">Settings · Single sign-on</h1>
          <p className="mt-1.5 max-w-3xl text-[14px]" style={{ color: "var(--color-ink-2)" }}>
            Let your team sign in through your own identity provider. A
            connection is gated on its allowlist of verified email domains:
            only people whose addresses match can sign in through it.
          </p>
        </header>
        <SettingsNav current="sso" />

        {allowSso ? (
          <SsoSection organizationId={active.id} connections={ssoRes.connections ?? []} />
        ) : (
          <section
            className="lift rounded-[2px] border p-5"
            style={{ background: "var(--color-surface)", borderColor: "var(--color-line)" }}
            data-feature="auth.sso"
          >
            <h2 className="text-[16px] font-semibold tracking-[-0.012em]">Single sign-on</h2>
            <p className="mt-2 text-[13.5px]" style={{ color: "var(--color-ink-2)" }}>
              Single sign-on is not included in your current plan.
            </p>
            <Link
              href="/billing"
              className="mt-2 inline-block text-[13px] font-semibold underline"
              style={{ color: "var(--color-ink)" }}
            >
              See plan options
            </Link>
          </section>
        )}
      </div>
    </Shell>
  );
}
