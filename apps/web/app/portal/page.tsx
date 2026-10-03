import Link from "next/link";
import { redirect } from "next/navigation";
import { getPortalOverview, PortalError } from "@/lib/api-portal";
import { portalDomainHref } from "@/lib/route-hrefs";
import { PortalDenied } from "@/components/portal-denied";

/**
 * The client portal. A contact sees their own organization's verified domains
 * and what the world's mail servers say about them — nothing else. FORENSIC
 * DATA NEVER APPEARS HERE (brief rule 5): this page and its domain view fetch
 * only the portal endpoints, which never carry it.
 *
 * White-label surface: the agency's brand is resolved server-side and applied
 * from the API's own branding response. A logo the agency typed is NEVER
 * rendered — only uploaded objects served by the platform.
 */
export default async function PortalPage() {
  let overview;
  try {
    overview = await getPortalOverview();
  } catch (error) {
    if (error instanceof PortalError) {
      if (error.status === 401) redirect("/sign-in");
      return (
        <PortalDenied
          message={
            error.status === 403
              ? "Ask the agency that manages your email authentication to invite you to a report."
              : (error.message ?? "The portal is temporarily unavailable.")
          }
        />
      );
    }
    throw error;
  }

  const brand = overview.branding;
  const accent = brand.branded && brand.primaryColor ? brand.primaryColor : undefined;

  return (
    <div data-surface="artefact" className="artefact relative z-10 min-h-screen">
      {/* The contact-facing header: the AGENCY's brand when licensed, never
          our own mark on a white-labelled surface. */}
      <header
        className="border-b px-6 py-4"
        style={{ borderColor: "var(--line-strong)", background: "var(--surface)" }}
      >
        <div className="mx-auto flex max-w-4xl items-center gap-3">
          {brand.branded && brand.logoUrl ? (
            // Only a platform-served uploaded object ever reaches an <img> here:
            // a user-typed logo URL is filtered out server-side and rendering
            // one would be a security bug (brief rule 4).
            <img src={brand.logoUrl} alt={`${brand.workspaceName} logo`} height={28} />
          ) : (
            <span
              className="num flex size-8 items-center justify-center text-[12px] font-semibold"
              style={{ background: accent ?? "var(--accent)", color: "var(--accent-ink)" }}
            >
              {brand.workspaceName.slice(0, 2).toUpperCase()}
            </span>
          )}
          <div>
            <div className="text-[15px] font-semibold" style={{ color: "var(--ink)" }}>
              {brand.workspaceName}
            </div>
            <div className="num text-[10px] tracking-[0.16em] uppercase" style={{ color: "var(--ink-3)" }}>
              client reports
            </div>
          </div>
          <a
            href="/api/auth/sign-out"
            className="num ml-auto text-[10px] tracking-[0.16em] uppercase"
            style={{ color: "var(--ink-3)" }}
          >
            sign out
          </a>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-6 py-12">
        <h1 className="text-[30px] leading-tight" style={{ color: "var(--ink)" }}>
          What the world's mail servers say about your domains.
        </h1>
        <p className="mt-4 text-[15px] leading-relaxed" style={{ color: "var(--ink-2)" }}>
          Measurement and evidence only — this portal shows what was observed,
          and never claims to block, filter or control anything.
        </p>

        <div className="num mt-4 flex gap-6 text-[11px]" style={{ color: "var(--ink-3)" }}>
          <span>{overview.totals.domains} domain{overview.totals.domains === 1 ? "" : "s"}</span>
          <span>{overview.totals.reports.toLocaleString("en-US")} reports received</span>
          <span>
            last report{" "}
            {overview.lastReportAt
              ? new Date(overview.lastReportAt).toLocaleDateString("en-GB", {
                  day: "numeric",
                  month: "short",
                  year: "numeric",
                })
              : "never"}
          </span>
        </div>

        {overview.clients.map((client) => (
          <section key={client.id} className="mt-10">
            <h2
              className="num border-b pb-2 text-[11px] tracking-[0.16em] uppercase"
              style={{ borderColor: "var(--line-strong)", color: "var(--ink-3)" }}
            >
              {client.name}
            </h2>
            {client.domains.length === 0 ? (
              <p className="mt-4 text-[13.5px]" style={{ color: "var(--ink-3)" }}>
                No verified domains yet. Measurement begins once a domain is
                verified and its reporters send their first aggregate report.
              </p>
            ) : (
              <ul className="mt-3 flex flex-col">
                {client.domains.map((d) => (
                  <li key={d.id}>
                    <Link
                      href={portalDomainHref(d.id)}
                      className="flex flex-wrap items-baseline gap-x-5 gap-y-1 border-b py-4 transition-colors"
                      style={{ borderColor: "var(--line)" }}
                    >
                      <span className="num text-[15px]" style={{ color: "var(--ink)" }}>
                        {d.name}
                      </span>
                      <span className="num text-[11.5px]" style={{ color: "var(--ink-2)" }}>
                        {d.dmarcPolicy ? `p=${d.dmarcPolicy}` : "no policy published"}
                      </span>
                      <span
                        className="num ml-auto text-[10px] tracking-[0.14em] uppercase"
                        style={{ color: "var(--ink-3)" }}
                      >
                        last scan{" "}
                        {d.lastScanAt
                          ? new Date(d.lastScanAt).toLocaleDateString("en-GB")
                          : "never"}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </main>

      <footer
        className="mx-auto max-w-4xl border-t px-6 py-8"
        style={{ borderColor: "var(--line)" }}
      >
        <p className="num text-[10.5px] leading-relaxed" style={{ color: "var(--ink-3)" }}>
          Reports you can see here are aggregate evidence about your domains.
          Forensic detail is held to a stricter boundary and is not part of this
          portal. Export and erasure of personal data are available on every
          plan at no cost.
        </p>
      </footer>
    </div>
  );
}
