import { appHostProblem, siteConfigWarnings, siteUrlProblem } from "./lib/site-config";

/**
 * Runs once when the server starts, before it takes a request
 * (node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/
 * instrumentation.md).
 *
 * A SITE_URL that is set but unusable stops the start: every canonical,
 * sitemap entry and security.txt line would otherwise be built on the request
 * host without anyone noticing (lib/site-config.ts). Settings that are only
 * missing or disagree are logged, because the verify harness and CI start a
 * production build without them on purpose.
 */
export function register(): void {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const production = process.env.NODE_ENV === "production";
  const problem = siteUrlProblem(process.env.SITE_URL, production) ?? appHostProblem(process.env.NEXT_PUBLIC_APP_HOST);
  if (problem) throw new Error(problem);
  if (!production) return;
  const warnings = siteConfigWarnings({
    SITE_URL: process.env.SITE_URL,
    NEXT_PUBLIC_APP_HOST: process.env.NEXT_PUBLIC_APP_HOST,
    GOOGLE_SITE_VERIFICATION: process.env.GOOGLE_SITE_VERIFICATION,
    BING_SITE_VERIFICATION: process.env.BING_SITE_VERIFICATION,
  });
  for (const warning of warnings) console.warn(`[site-config] ${warning}`);
}
