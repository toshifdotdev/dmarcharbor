import Link from "next/link";
import { readHostBrand } from "@/lib/host-brand";
import { LEGAL_DOCS, LEGAL_VERSION, LEGAL_EFFECTIVE_DATE, SUPPORT_PHONE_PLACEHOLDER } from "@/lib/legal-docs";
import {
  HostUnverifiedBanner,
  MarketingFooter,
  MarketingHeader,
  brandName,
} from "@/components/marketing";

/**
 * /support — the support page. Public, loads signed out.
 *
 * Both contact routes are here because Paddle requires an email AND a phone
 * number on a support page. The phone number is the business's to supply: an
 * invented contact detail on a legal page is a worse defect than a visible
 * placeholder, so the placeholder says exactly what is missing.
 */
export function generateMetadata() {
  return { title: "Support" };
}

export default async function SupportPage() {
  const brand = await readHostBrand();

  return (
    <div className="relative z-10 min-h-screen" data-host-brand={brand.state}>
      {brand.state === "unverified" ? <HostUnverifiedBanner /> : null}
      <MarketingHeader brand={brand} />

      <main className="mx-auto w-full max-w-[720px] px-6 py-12">
        <header className="border-b pb-6" style={{ borderColor: "var(--color-line-strong)" }}>
          <p className="label">{brandName(brand)} · Support</p>
          <h1
            className="mt-2 text-[30px] font-semibold leading-[1.15] tracking-[-0.03em]"
            style={{ fontFamily: "var(--font-display)" }}
          >
            How to reach us
          </h1>
          <p className="num mt-2 text-[11.5px]" style={{ color: "var(--color-ink-3)" }}>
            version {LEGAL_VERSION} · effective {LEGAL_EFFECTIVE_DATE}
          </p>
        </header>

        <section className="mt-8">
          <h2
            className="text-[19px] font-semibold tracking-[-0.02em]"
            style={{ fontFamily: "var(--font-display)", color: "var(--color-ink)" }}
          >
            Email
          </h2>
          <p className="mt-3 text-[13.5px] leading-[1.8]" style={{ color: "var(--color-ink-2)" }}>
            For anything about the product, your account, or your data:
          </p>
          <p className="num mt-2 text-[14px]">
            <a href="mailto:support@dmarcharbor.com" className="underline" style={{ color: "var(--color-ink)" }}>
              support@dmarcharbor.com
            </a>
          </p>
          <p className="mt-2 text-[13px] leading-[1.8]" style={{ color: "var(--color-ink-2)" }}>
            We answer within one working day. For privacy questions, write to{" "}
            <a href="mailto:privacy@dmarcharbor.com" className="underline" style={{ color: "var(--color-ink)" }}>
              privacy@dmarcharbor.com
            </a>
            ; for complaints, see the{" "}
            <Link href="/complaints" className="underline" style={{ color: "var(--color-ink)" }}>
              Complaint Policy
            </Link>
            .
          </p>
        </section>

        <section className="mt-8">
          <h2
            className="text-[19px] font-semibold tracking-[-0.02em]"
            style={{ fontFamily: "var(--font-display)", color: "var(--color-ink)" }}
          >
            Phone
          </h2>
          {/* The phone number is the business's to supply: an invented contact
              detail on a legal page is a worse defect than a visible gap. The
              marker comes from the shared constant, so it is replaced in one
              edit when the number lands. */}
          <p
            role="status"
            className="mt-3 text-[13.5px] leading-[1.8]"
            style={{ color: "var(--color-unverified)" }}
          >
            {SUPPORT_PHONE_PLACEHOLDER}
          </p>
          <p className="mt-2 text-[13px] leading-[1.8]" style={{ color: "var(--color-ink-2)" }}>
            Phone support hours are published with the number. Email support runs
            every working day regardless.
          </p>
        </section>

        <section className="mt-8">
          <h2
            className="text-[19px] font-semibold tracking-[-0.02em]"
            style={{ fontFamily: "var(--font-display)", color: "var(--color-ink)" }}
          >
            Payments
          </h2>
          <p className="mt-3 text-[13.5px] leading-[1.8]" style={{ color: "var(--color-ink-2)" }}>
            Orders placed through our online reseller Paddle.com are served by
            Paddle's own customer service, which handles returns for those
            orders. Our own email support covers the product and your account in
            every case.
          </p>
        </section>

        <nav
          className="mt-12 border-t pt-6"
          style={{ borderColor: "var(--color-line-strong)" }}
          aria-label="Legal documents"
        >
          <p className="label">All documents</p>
          <ul className="mt-3 grid grid-cols-1 gap-x-8 gap-y-1.5 sm:grid-cols-2">
            {LEGAL_DOCS.map((d) => (
              <li key={d.slug}>
                <Link href={`/${d.slug}`} className="text-[13px] underline" style={{ color: "var(--color-ink-2)" }}>
                  {d.title}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </main>

      <MarketingFooter brand={brand} />
    </div>
  );
}
