import type { Metadata } from "next";
import { getBranding, getResolvedBranding, getWorkspaceEntitlements, OpsError } from "@/lib/api-ops";
import { featureOf } from "@/lib/entitlements";
import { settingsContext } from "@/lib/settings-context";
import { mayChange } from "@/lib/settings-map";
import { PlanUnknown } from "@/components/harbor/plan-refusal";
import { BrandingBoard } from "@/components/harbor/settings/branding";
import { SettingsFrame } from "@/components/harbor/settings/frame";
import { ErrorState, PermissionState } from "@/components/ui/states";

export const metadata: Metadata = { title: "White label" };

/** /settings/branding — reading needs owner or admin (organization:read). */
export default async function BrandingPage() {
  const ctx = await settingsContext();
  const [branding, resolved, entitlements] = await Promise.all([
    getBranding(ctx.active.id).catch((e: unknown) => (e instanceof OpsError && e.status === 403 ? ("forbidden" as const) : null)),
    getResolvedBranding(ctx.active.id).catch(() => null),
    getWorkspaceEntitlements(ctx.active.id).catch(() => null),
  ]);

  return (
    <SettingsFrame
      ctx={ctx}
      section="branding"
      lede="Your name, logo and colours on everything a client opens, in place of ours, from Harbor up. On Admiralty, client pages can also open on your own domain. Check the preview before you save: it is what they will see."
    >
      {entitlements === null ? <PlanUnknown what="white label" /> : null}
      {branding === "forbidden" ? (
        <PermissionState what="white label" back={{ label: "All settings", href: "/settings" }} />
      ) : branding === null ? (
        <ErrorState what="the white label settings" detail="Nothing was changed. Retry to read them." />
      ) : (
        <BrandingBoard
          organizationId={ctx.active.id}
          workspaceName={resolved?.workspaceName ?? ctx.active.name}
          primary={branding.brandPrimaryColor}
          ink={branding.brandAccentColor}
          logoUrl={resolved?.logoUrl ?? null}
          customDomain={branding.customDomain}
          customDomainVerified={Boolean(branding.customDomainVerifiedAt)}
          whitelabel={featureOf(entitlements, "branding.whitelabel")}
          logoUpload={featureOf(entitlements, "branding.logoUpload")}
          customDomainFeature={featureOf(entitlements, "branding.customDomain")}
          canManage={ctx.role === null ? true : mayChange(ctx.role, "admin")}
        />
      )}
    </SettingsFrame>
  );
}
