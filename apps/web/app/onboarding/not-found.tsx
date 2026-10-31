import { NotFoundView } from "@/components/harbor/not-found-view";

/**
 * notFound() from a domain's setup page: the id names no domain this
 * workspace can see, usually a link copied from another workspace.
 */
export default function OnboardingNotFound() {
  return (
    <NotFoundView
      title="There is no setup for this domain here."
      lead={
        <p>
          The domain is not in this workspace. It may have been removed, or it belongs to another workspace: switch
          workspace from the menu at the top, or add the domain from Clients.
        </p>
      }
      appPlaces={[{ href: "/clients", label: "Clients" }]}
      trail={[{ label: "Clients", href: "/clients" }, { label: "Setup not found" }]}
    />
  );
}
