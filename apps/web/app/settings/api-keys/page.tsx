import { redirect } from "next/navigation";
import { listApiKeys, getWorkspaceEntitlements } from "@/lib/api-ops";
import { resolveActiveWorkspace } from "@/lib/session";
import Link from "next/link";
import { Shell } from "@/components/shell";
import { SettingsNav } from "@/components/settings-nav";
import { ApiKeysPanel } from "@/components/api-keys-client";
import { ErrorState } from "@/components/data-states";

/**
 * API keys. A failed key list is NOT "no keys": on this screen the list IS
 * the audit of who can call the public API, and a silent empty list would
 * hide a key an operator is trying to find. Failure renders as failure.
 */
export default async function ApiKeysSettingsPage() {
  const { workspaces, active } = await resolveActiveWorkspace();
  if (!active) redirect("/welcome");

  const [keyRes, entitlements] = await Promise.all([
    listApiKeys(active.id)
      .then((r) => ({ keys: r.apiKeys ?? [], failed: false }))
      .catch(() => ({ keys: [], failed: true })),
    getWorkspaceEntitlements(active.id).catch(() => null),
  ]);
  const allowApi = entitlements?.features["api.access"] === true;

  return (
    <Shell workspaces={workspaces} activeWorkspace={active}>
      <div className="flex flex-col gap-5">
        <header>
          <h1 className="label">Settings · API keys</h1>
          <p className="mt-1.5 max-w-3xl text-[14px]" style={{ color: "var(--color-ink-2)" }}>
            Keys for the public API. A key is shown once at creation and never
            again: the platform stores only its hash.
          </p>
        </header>
        <SettingsNav current="api-keys" />

        {keyRes.failed ? (
          <ErrorState
            what="the API key list"
            detail="This list is the audit of who can call the public API: an empty list here would hide keys that exist, not show a clean account."
          />
        ) : allowApi ? (
          <ApiKeysPanel organizationId={active.id} keys={keyRes.keys} />
        ) : (
          <section
            className="lift rounded-[2px] border p-5"
            style={{ background: "var(--color-surface)", borderColor: "var(--color-line)" }}
            data-feature="api.access"
          >
            <h2 className="text-[16px] font-semibold tracking-[-0.012em]">API keys</h2>
            <p className="mt-2 text-[13.5px]" style={{ color: "var(--color-ink-2)" }}>
              API access is not included in your current plan.
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
