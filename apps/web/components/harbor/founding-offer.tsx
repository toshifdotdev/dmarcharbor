import type { HostBrand } from "@/lib/host-brand";
import { isOwnPublicHost } from "@/lib/site-origin";

/**
 * Static founding-offer line above the public header on / and /pricing.
 *
 * Shown on our own host only: never on an agency's verified white-label domain,
 * and never on an unverified or unknown host pointed at the deployment.
 */
export async function FoundingOffer({ brand }: { brand: HostBrand }) {
  if (brand.state === "verified" || brand.state === "unverified") return null;
  if (brand.state !== "default" && !(await isOwnPublicHost())) return null;

  return (
    <div data-testid="founding-offer" className="border-b border-rule bg-paper">
      <div className="page-wrap py-2.5 sm:text-center">
        <p className="text-[14px] leading-[1.45] text-fg sm:text-[14.5px]">
          <strong className="font-bold">Founding offer:</strong> our first 10 MSPs get Harbor free for their first
          month, and we set up their first five client domains for them.{" "}
          <a
            href="mailto:toshif@dmarcharbor.com?subject=Founding%20offer"
            className="whitespace-nowrap font-semibold text-act underline decoration-act/40 decoration-1 underline-offset-[3px] transition-colors duration-100 hover:decoration-current"
          >
            Contact us &rarr;
          </a>
        </p>
      </div>
    </div>
  );
}
