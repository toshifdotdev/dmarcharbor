/**
 * What a client contact reads when asked to approve a stricter DMARC policy.
 *
 * The contact is the agency's customer: an office manager or a director, not
 * an email engineer. So the request says what changes for mail claiming to be
 * from their domain, what the risk to their own mail is, and what evidence the
 * agency is relying on, in sentences rather than tags. The email and the
 * portal both read from here so the two never describe the same change
 * differently.
 */

export interface ProposalEvidence {
  daysObserved: number;
  daysAtCurrentPolicy: number;
  messagesObserved: number;
  passRatePercent: number | null;
  dkimPassRatePercent: number | null;
  failingSenders: number;
  observedSenders: number;
}

export interface ProposalWords {
  /** One line naming the change, e.g. "Send fake email from acme.com to spam". */
  headline: string;
  /** What happens to mail that fails the checks once this is live. */
  effect: string;
  /** Present when the change starts as a trial (t=y). */
  trial: string | null;
  /** The honest risk to the client's own mail. */
  risk: string;
  /** The evidence in one sentence, or null when there is none to quote. */
  evidence: string | null;
}

function formatCount(value: number): string {
  return value.toLocaleString('en-GB');
}

export function describeProposal(input: {
  domainName: string;
  agencyName: string;
  policy: string;
  testing: boolean;
  evidence: ProposalEvidence;
}): ProposalWords {
  const domain = input.domainName;
  const reject = input.policy === 'reject';

  const headline = reject
    ? `Refuse fake email that claims to be from ${domain}`
    : `Send fake email that claims to be from ${domain} to spam`;

  const effect = reject
    ? `Email that claims to come from ${domain} but fails the authenticity checks will be refused by the receiving mail server, so it never reaches anyone. This is what stops criminals sending invoices and payment requests in your name.`
    : `Email that claims to come from ${domain} but fails the authenticity checks will go to the recipient's spam folder instead of their inbox. Fake invoices and payment requests in your name become much less likely to be read.`;

  const trial = input.testing
    ? reject
      ? 'This starts as a trial: failing mail goes to spam rather than being refused, while the reports are watched. Refusing it outright is a later, separate step.'
      : 'This starts as a trial: receivers keep delivering mail as they do now and report what they would have sent to spam. Nothing changes for your mail until the trial is ended.'
    : null;

  const risk = `If one of your own services sends email as ${domain} without passing these checks, its mail is affected too. If you use a mailing tool, CRM, billing or booking system that ${input.agencyName} may not know about, tell them before approving.`;

  const evidence =
    input.evidence.passRatePercent !== null && input.evidence.messagesObserved > 0
      ? `${input.evidence.passRatePercent}% of the ${formatCount(input.evidence.messagesObserved)} messages seen over the last ${input.evidence.daysObserved} days passed the checks${
          input.evidence.observedSenders > 0
            ? `, and ${input.evidence.failingSenders} of the ${input.evidence.observedSenders} services sending as ${domain} are failing them`
            : ''
        }.`
      : null;

  return { headline, effect, trial, risk, evidence };
}

/** The policy as the agency reads it: "p=quarantine (trial)". */
export function policyLabel(policy: string, testing: boolean): string {
  return `p=${policy}${testing && policy !== 'none' ? ' (trial, t=y)' : ''}`;
}
