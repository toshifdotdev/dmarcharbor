import { redirect } from "next/navigation";
import { getBranding, getWorkspaceEntitlements } from "@/lib/api-ops";
import { resolveActiveWorkspace } from "@/lib/session";
import { Shell } from "@/components/shell";
import { SettingsNav } from "@/components/settings-nav";
import { WhiteLabelForm } from "@/components/settings-client";

/**
 * White label — Admiralty for the branding features. Two things the brief
 * insists on, both enforced here:
 *
 * - If the custom domain is unverified, SAY SO PLAINLY. The form states that
 *   the domain serves only after its TXT record verifies — never letting a
 *   customer assume their branding is live.
 * - A typed logo URL is never rendered. Logos are platform-served uploaded
 *   objects only (three-step upload, confirm with the workspace's own
 *   objectKey).
 */
export default async function BrandingSettingsPage() {
  const { workspaces, active } = await resolveActiveWorkspace();
  if (!active) redirect("/welcome");

  const [branding, entitlements] = await Promise.all([
    getBranding(active.id).catch(() => null),
    getWorkspaceEntitlements(active.id).catch(() => null),
  ]);
  const allowWhiteLabel = entitlements?.features["branding.whitelabel"] === true;
  const allowLogoUpload = entitlements?.features["branding.logoUpload"] === true;

  return (
    <Shell workspaces={workspaces} activeWorkspace={active}>
      <div className="flex flex-col gap-5">
        <header>
          <h1 className="label">Settings · White label</h1>
          <p className="mt-1.5 max-w-3xl text-[14px]" style={{ color: "var(--color-ink-2)" }}>
            Client-facing pages in your brand, not ours: the portal, the
            digests, the report shares.
          </p>
        </header>
        <SettingsNav current="branding" />

        {branding ? (
          <>
            {/* Plainly: unverified means the branding is NOT live yet. */}
            {branding.customDomain ? (
              branding.customDomainVerifiedAt ? (
                <div
                  data-testid="domain-verified"
                  className="rounded-[2px] border px-4 py-3"
                  style={{ borderColor: "var(--color-pass)", background: "var(--color-pass-soft)" }}
                >
                  <p className="num text-[11px] font-semibold tracking-[0.12em] uppercase" style={{ color: "var(--color-pass)" }}>
                    Custom domain live
                  </p>
                  <p className="mt-1.5 text-[13px]" style={{ color: "var(--color-ink-2)" }}>
                    <span className="num">{branding.customDomain}</span> verified{" "}
                    {new Date(branding.customDomainVerifiedAt).toLocaleDateString("en-GB")}:
                    client-facing pages are being served under your brand there.
                  </p>
                </div>
              ) : (
                <div
                  data-testid="domain-unverified"
                  className="rounded-[2px] border px-4 py-3"
                  style={{ borderColor: "var(--color-unverified)", background: "var(--color-unverified-soft)" }}
                >
                  <p className="num text-[11px] font-semibold tracking-[0.12em] uppercase" style={{ color: "var(--color-unverified)" }}>
                    Custom domain not live yet
                  </p>
                  <p className="mt-1.5 text-[13px]" style={{ color: "var(--color-ink-2)" }}>
                    <span className="num">{branding.customDomain}</span> is saved but{" "}
                    <strong style={{ color: "var(--color-ink)" }}>its TXT record has not
                    been verified</strong>, so your branding is NOT being served there yet.
                    Publish the TXT record at your DNS provider, then verify below.
                  </p>
                </div>
              )
            ) : null}

            <WhiteLabelForm
              organizationId={active.id}
              branding={branding}
              allowLogoUpload={allowLogoUpload}
              allowWhiteLabel={allowWhiteLabel}
            />
          </>
        ) : (
          <p role="alert" className="text-[13.5px]" style={{ color: "var(--color-block)" }}>
            Branding settings could not be loaded.
          </p>
        )}
      </div>
    </Shell>
  );
}
