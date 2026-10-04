/**
 * legal-docs.ts — the registry behind the public legal pages.
 *
 * The body of each document is a FILE, not a string in this repo's source:
 * when the supplied text lands in docs/, the page renders it with no code
 * change. Until a file exists, the page renders an honest placeholder that
 * names what is missing — an invented legal paragraph is worse than a visible
 * gap, and the placeholder is gone the moment the file lands.
 *
 * Every document carries a version and an effective date, because an
 * acceptance record must point at a specific text. A document without a
 * version cannot be the thing an acceptance points at.
 *
 * The Paddle paragraph in Terms is verbatim by requirement — Paddle's brand
 * guidelines mandate the exact wording, so it lives here as its own string and
 * is never reworded, shortened, or reformatted.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Paddle's mandated paragraph, word for word. A compliance requirement of the
 *  payment processor — not our copy to rewrite. */
export const PADDLE_ORDER_PROCESS_PARAGRAPH =
  "Our order process is conducted by our online reseller Paddle.com. Paddle.com is the Merchant of Record for all our orders. Paddle provides all customer service inquiries and handles returns.";

/** The version of these documents. ONE constant: the acceptance record stores
 *  the DPA version (apps/api's currentDpaVersion), and a page that printed a
 *  different string would make the evidence point at a document nobody can
 *  see. The click-through asserts the rendered page and the API record are
 *  equal, so drift fails a run instead of hiding until an audit. */
export const LEGAL_VERSION = "1.0";

/** The effective date of these documents. ONE constant across every page:
 *  an acceptance record must answer "which version, and when did it start".
 *  The launch date lands here when the business confirms it. */
export const LEGAL_EFFECTIVE_DATE = "to be set at launch";

/** The legal entity name. Supplied by the business, never invented here: an
 *  invented entity on a legal page is a worse defect than a visible
 *  placeholder. */
export const LEGAL_ENTITY_PLACEHOLDER = "[legal entity name: supplied by the business before launch]";

/** The support phone and registered address, same rule as the entity name. */
export const SUPPORT_PHONE_PLACEHOLDER = "[phone number: supplied by the business before launch]";
export const REGISTERED_ADDRESS_PLACEHOLDER = "[registered address: supplied by the business before launch]";

/** The support email: supplied, so it substitutes as a real value. */
export const SUPPORT_EMAIL = "support@dmarcharbor.com";

/** Tokens in the supplied documents, replaced as the markdown is rendered.
 *  Supplied values substitute as themselves; unsupplied ones become
 *  obviously-incomplete markers rather than plausible-looking values. Every
 *  other [TOKEN] in a document is left alone: a raw bracket is already the
 *  honest marker the document carries until its business supplies the fact. */
const LEGAL_SUBSTITUTIONS: Array<[RegExp, string]> = [
  [/\[YOUR LEGAL ENTITY NAME\]/g, LEGAL_ENTITY_PLACEHOLDER],
  [/\[EFFECTIVE DATE\]/g, LEGAL_EFFECTIVE_DATE],
  [/\[SUPPORT EMAIL\]/g, SUPPORT_EMAIL],
  [/\[SUPPORT PHONE\]/g, SUPPORT_PHONE_PLACEHOLDER],
  [/\[REGISTERED ADDRESS\]/g, REGISTERED_ADDRESS_PLACEHOLDER],
];

export interface LegalDoc {
  slug: string;
  title: string;
  /** File under docs/ whose markdown is the body, when it exists. */
  sourceFile: string | null;
  /** Rendered instead of the file while the supplied text is not yet landed. */
  placeholder?: string[];
  /** Sections that must render regardless of the file (verbatim requirements). */
  required?: Array<{ heading: string; paragraphs: string[] }>;
}

export const LEGAL_DOCS: LegalDoc[] = [
  {
    slug: "privacy",
    title: "Privacy Policy",
    sourceFile: "PRIVACY-POLICY.md",
  },
  {
    slug: "terms",
    title: "Terms of Service",
    sourceFile: "TERMS-OF-SERVICE.md",
    placeholder: [
      "The full text of these terms is being finalised and will be published here before launch. This page exists so that the acceptance record on checkout can point at a specific document version.",
    ],
    required: [
      {
        heading: "Merchant of Record",
        paragraphs: [PADDLE_ORDER_PROCESS_PARAGRAPH],
      },
      {
        heading: "The parties",
        paragraphs: [
          `These terms are between ${LEGAL_ENTITY_PLACEHOLDER} ("we", "us") and the customer identified in the account or order form ("you").`,
        ],
      },
    ],
  },
  {
    slug: "dpa",
    title: "Data Processing Agreement",
    sourceFile: "DPA.md",
  },
  {
    slug: "refunds",
    title: "Refund Policy",
    sourceFile: "REFUND-POLICY.md",
    placeholder: [
      "The full text of the refund policy is being finalised and will be published here before launch. It is linked from the billing page because that is where the question arises.",
    ],
    required: [
      {
        heading: "Merchant of Record",
        paragraphs: [
          "Payments are handled by our online reseller Paddle.com, which is the Merchant of Record and handles returns.",
        ],
      },
    ],
  },
  {
    slug: "acceptable-use",
    title: "Acceptable Use Policy",
    sourceFile: "ACCEPTABLE-USE-POLICY.md",
    placeholder: [
      "The full text of the acceptable use policy is being finalised and will be published here before launch.",
    ],
  },
  {
    slug: "security",
    title: "Security Policy",
    sourceFile: "SECURITY.md",
  },
  {
    slug: "sub-processors",
    title: "Sub-processors",
    sourceFile: "SUB-PROCESSORS.md",
  },
  {
    slug: "faq",
    title: "Frequently Asked Questions",
    sourceFile: "FAQ.md",
    placeholder: [
      "The FAQ is being written and will be published here before launch.",
    ],
  },
  {
    slug: "complaints",
    title: "Complaint Policy",
    sourceFile: "COMPLAINT-POLICY.md",
    placeholder: [
      "The full complaint policy is being finalised and will be published here before launch. It exists as its own page because our payment processor requires a complaint route that is reachable without an account.",
    ],
    required: [
      {
        heading: "How to complain",
        paragraphs: [
          "Write to complaints@dmarcharbor.com with what happened, when, and what you would like done. We acknowledge within two working days and answer within fifteen.",
          `If you paid through Paddle, you can also raise a complaint through Paddle's own dispute process: Paddle is the Merchant of Record for those orders.`,
        ],
      },
    ],
  },
  {
    slug: "cookies",
    title: "Cookie Policy",
    sourceFile: "COOKIE-POLICY.md",
    placeholder: [
      "The cookie policy is being finalised and will be published here before launch.",
    ],
  },
];

export const LEGAL_BY_SLUG = new Map(LEGAL_DOCS.map((d) => [d.slug, d]));

/** The document body: the file when it exists, the honest placeholder when it
 *  does not. Never both — a placeholder must not survive its file. */
/** The document body: the file when it exists, the honest placeholder when it
 *  does not. Never both — a placeholder must not survive its file. Supplied
 *  facts substitute as the body is read, so one constant change lands on every
 *  page instead of leaving a hand-edited copy in each document. */
export function legalBody(doc: LegalDoc): { kind: "file" | "placeholder"; text: string } {
  if (doc.sourceFile) {
    try {
      const raw = readFileSync(join(process.cwd(), "..", "..", "docs", doc.sourceFile), "utf8");
      let text = raw;
      for (const [pattern, value] of LEGAL_SUBSTITUTIONS) text = text.replace(pattern, value);
      return { kind: "file", text };
    } catch {
      // The file has not landed yet: fall through to the placeholder.
    }
  }
  return {
    kind: "placeholder",
    text: (doc.placeholder ?? ["This document is being finalised and will be published before launch."]).join(
      "\n\n",
    ),
  };
}
