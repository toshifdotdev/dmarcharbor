/**
 * site-links.ts — the legal surface, one list for every footer.
 *
 * Shared by the Monolith footer (components/marketing.tsx re-exports it) and the
 * Chart shell and public footer, so the two systems cannot drift apart while the
 * rebuild is in progress. Every entry is a route that exists.
 */

export const LEGAL_FOOTER_LINKS: Array<[string, string]> = [
  ["/privacy", "Privacy"],
  ["/terms", "Terms"],
  ["/dpa", "DPA"],
  ["/refunds", "Refunds"],
  ["/acceptable-use", "Acceptable use"],
  ["/security", "Security"],
  ["/sub-processors", "Sub-processors"],
  ["/complaints", "Complaints"],
  ["/guide", "Setup guide"],
  ["/faq", "FAQ"],
  ["/cookies", "Cookies"],
  ["/support", "Support"],
];
