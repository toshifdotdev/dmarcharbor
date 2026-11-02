/**
 * site-links.ts — the legal surface, one list for every footer.
 *
 * Shared by the app shell's footer, the public footer and the sign-in frame,
 * so no footer can drift from the others. Every entry is a route that exists.
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
  ["/docs/api", "API docs"],
  ["/faq", "FAQ"],
  ["/cookies", "Cookies"],
  ["/support", "Support"],
];
