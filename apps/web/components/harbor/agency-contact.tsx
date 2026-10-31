/**
 * agency-contact.tsx — "Questions? Contact Wistholm IT at help@wistholm.example
 * or on their support page."
 *
 * The contact an agency publishes to its clients (Settings, White label,
 * Client contact), shown where a client looks for help: the portal's foot and
 * the sign-in page on the agency's domain. Takes values already checked by
 * lib/agency-contact.ts, so only one plain address becomes a mailto: link and
 * only an https page becomes an href. Renders nothing when neither is set.
 */

import { mailtoHref, type AgencyContact as Contact } from "@/lib/agency-contact";

export function AgencyContactLine({
  lead,
  agency,
  contact,
  className,
  testId,
}: {
  /** The question the line answers: "Questions?", "Trouble signing in?". */
  lead: string;
  agency: string;
  contact: Contact | null;
  className?: string;
  testId?: string;
}) {
  if (!contact || (!contact.email && !contact.url)) return null;
  const page = contact.url ? (
    <a href={contact.url} target="_blank" rel="noopener noreferrer" className="link">
      their support page<span className="sr-only"> (opens in a new tab)</span>
    </a>
  ) : null;
  return (
    <p data-testid={testId} className={className}>
      {lead} Contact <span className="font-semibold text-fg-2">{agency}</span>
      {contact.email ? (
        <>
          {" "}
          at{" "}
          <a href={mailtoHref(contact.email)} className="link break-all">
            {contact.email}
          </a>
          {page ? <> or on {page}</> : null}
        </>
      ) : (
        <> on {page}</>
      )}
      .
    </p>
  );
}
