import { NotFoundView } from "@/components/harbor/not-found-view";

/**
 * notFound() from a domain's detail: the id names no domain this workspace
 * can see. The likeliest cause is a link copied from another workspace, so
 * the page says where to look rather than only that it is missing.
 */
export default function DomainNotFound() {
  return (
    <NotFoundView
      title="This domain is not in this workspace."
      lead={
        <p>
          It may have been removed, or it belongs to another workspace: switch workspace from the menu at the top, or
          find the domain under Clients.
        </p>
      }
      appPlaces={[{ href: "/clients", label: "Clients" }]}
      trail={[{ label: "Clients", href: "/clients" }, { label: "Domain not found" }]}
    />
  );
}
