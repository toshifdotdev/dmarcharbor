import type { Metadata } from "next";
import { NotFoundView } from "@/components/harbor/not-found-view";
import { brandName } from "@/components/harbor/public-frame";
import { readHostBrand } from "@/lib/host-brand";

/**
 * The 404 for every address that matches no route, and for notFound() in any
 * segment without a not-found of its own. Signed in, it keeps the app's frame;
 * otherwise it is a slim page with only the host's name (the agency's on its
 * verified domain) and places that exist on that host. See
 * components/harbor/not-found-view.tsx.
 */
export async function generateMetadata(): Promise<Metadata> {
  // Absolute, so the layout's "· DMARC Harbor" template does not name us on
  // an agency's domain.
  return { title: { absolute: `Page not found · ${brandName(await readHostBrand())}` } };
}

export default function NotFound() {
  return (
    <NotFoundView
      title="This page does not exist."
      lead={<p>The address may have changed, or the link may be wrong. These all exist:</p>}
      appPlaces={[
        { href: "/clients", label: "Clients" },
        { href: "/alerts", label: "Alerts" },
        { href: "/settings", label: "Settings" },
      ]}
      trail={[{ label: "Page not found" }]}
    />
  );
}
