import type { Metadata } from "next";
import Link from "next/link";
import { LEGAL_DOCS, SUPPORT_EMAIL, SUPPORT_PHONE_PLACEHOLDER } from "@/lib/legal-docs";
import { requestOrigin } from "@/lib/metadata-origin";
import { publicMetadata } from "@/lib/seo";
import { DocumentFrame } from "@/components/harbor/legal-document";
import { LegalHeading2 } from "@/components/harbor/legal-render";
import { CopyValue } from "@/components/ui/copy";

/**
 * /support — how to reach a person. Public, loads signed out.
 *
 * Both contact routes are here because Paddle requires an email AND a phone
 * number on a support page. The phone number is the business's to supply: an
 * invented contact detail is a worse defect than a visible gap, so it is shown
 * as pending in place.
 *
 * Built for the person writing in at the worst moment: the address is
 * copyable, and "Write to support" opens an email already laid out with the
 * four things a first reply would otherwise have to ask for. Nothing here
 * promises a response time the existing support policy does not state.
 *
 * Indexed: a buyer with no account has to be able to find how to reach us.
 */
export async function generateMetadata(): Promise<Metadata> {
  const origin = await requestOrigin();
  return publicMetadata({
    title: "Support and contact",
    description:
      "How to reach us: email and phone, what a support request needs to contain, and how long an answer takes. Both routes work without an account.",
    path: "/support",
    origin,
  });
}

const TEMPLATE = [
  "Domain (exactly as it sends mail):",
  "Workspace name:",
  "What you saw, and what you expected:",
  "When it happened (date, time and time zone):",
  "",
].join("\n");

const HEADINGS = [
  { id: "email", text: "Email" },
  { id: "what-to-include", text: "What to include" },
  { id: "phone", text: "Phone" },
  { id: "payments", text: "Payments" },
  { id: "other-routes", text: "Privacy and complaints" },
];

export default function SupportPage() {
  const mailto = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent("Support request: ")}&body=${encodeURIComponent(TEMPLATE)}`;
  const complaints = LEGAL_DOCS.find((d) => d.slug === "complaints");

  return (
    <DocumentFrame slug="support" kicker="Support" title="How to reach us" headings={HEADINGS} current="support">
      <section className="mt-10 first:mt-0">
        <LegalHeading2 id="email">Email</LegalHeading2>
        <div className="mt-4 flex max-w-[70ch] flex-col gap-3 text-body text-fg-2">
          <p>For anything about the product, your account, or your data. We answer within one working day.</p>
          <CopyValue value={SUPPORT_EMAIL} label="support address" className="max-w-[420px]" />
          <p>
            <a href={mailto} className="link font-semibold">
              Write to support
            </a>{" "}
            <span className="text-fg-3">opens your mail app with the details below already laid out.</span>
          </p>
        </div>
      </section>

      <section className="mt-10 first:mt-0">
        <LegalHeading2 id="what-to-include">What to include</LegalHeading2>
        <p className="mt-4 max-w-[70ch] text-body text-fg-2">
          These four answer most first questions, so the first reply can be an answer rather than a request for detail.
        </p>
        <ol className="mt-4 grid max-w-[70ch] border-t border-rule">
          {[
            ["The domain", "exactly as it sends mail, for example billing.client.example rather than the client's name."],
            ["The workspace", "the name shown at the start of the location bar when you are signed in."],
            ["What you saw", "and what you expected instead. A screenshot helps; a DNS record pasted as text helps more."],
            ["When", "the date, time and time zone. Reports arrive daily, so the day matters."],
          ].map(([k, v], i) => (
            <li key={k} className="grid grid-cols-[28px_120px_minmax(0,1fr)] gap-3 border-b border-rule py-2.5 text-body">
              <span className="tnum font-semibold text-fg-3">{i + 1}</span>
              <span className="font-bold text-fg">{k}</span>
              <span className="text-fg-2">{v}</span>
            </li>
          ))}
        </ol>
        <p className="mt-3 max-w-[70ch] text-meta text-fg-3">
          Never send a password, an API key or a webhook secret. Support never needs one.
        </p>
      </section>

      <section className="mt-10 first:mt-0">
        <LegalHeading2 id="phone">Phone</LegalHeading2>
        <div className="mt-4 flex max-w-[70ch] flex-col gap-2 text-body text-fg-2">
          <p role="status">
            <mark className="rounded-[2px] bg-warn-wash px-1 font-semibold text-warn">{SUPPORT_PHONE_PLACEHOLDER}</mark>
          </p>
          <p>Phone support hours are published with the number. Email support runs every working day regardless.</p>
        </div>
      </section>

      <section className="mt-10 first:mt-0">
        <LegalHeading2 id="payments">Payments</LegalHeading2>
        <p className="mt-4 max-w-[70ch] text-body text-fg-2">
          Orders placed through our online reseller Paddle.com are served by Paddle&rsquo;s own customer service, which
          handles returns for those orders. Our own email support covers the product and your account in every case. The{" "}
          {/* Anchor id is the heading's slug: "6. Order process and merchant of record". */}
          <Link href="/terms#6-order-process-and-merchant-of-record" className="link">
            Terms
          </Link>{" "}
          say which company sells to you, by the currency you paid in.
        </p>
      </section>

      <section className="mt-10 first:mt-0">
        <LegalHeading2 id="other-routes">Privacy and complaints</LegalHeading2>
        <div className="mt-4 flex max-w-[70ch] flex-col gap-3 text-body text-fg-2">
          <p>Questions about personal data, or a request under data protection law:</p>
          <CopyValue value="privacy@dmarcharbor.com" label="privacy address" className="max-w-[420px]" />
          <p>
            A complaint has its own route and its own timetable, set out in the{" "}
            <Link href="/complaints" className="link">
              {complaints?.title ?? "Complaint Policy"}
            </Link>
            .
          </p>
        </div>
      </section>
    </DocumentFrame>
  );
}
