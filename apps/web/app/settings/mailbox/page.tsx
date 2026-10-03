import Link from "next/link";
import { getReportInbox, getWorkspaceEntitlements } from "@/lib/api-ops";
import { resolveActiveWorkspace } from "@/lib/session";
import { Shell } from "@/components/shell";
import { SettingsNav } from "@/components/settings-nav";
import { ReportInboxForm } from "@/components/settings-client";

/**
 * Report mailbox — the shared mailbox DMARC reports are collected from.
 *
 * This section is the answer to the rua=https problem, and the two are
 * connected on purpose: a domain publishing reports to a web endpoint we
 * cannot read can point its rua tag at a mailbox collected here instead.
 * The onboarding step for such a domain links straight to this section.
 */
export default async function MailboxSettingsPage() {
  const { workspaces, active } = await resolveActiveWorkspace();
  if (!active) return null;

  const [inbox, entitlements] = await Promise.all([
    getReportInbox(active.id).catch(() => null),
    getWorkspaceEntitlements(active.id).catch(() => null),
  ]);
  const allowInbox = entitlements?.features["reports.inbox"] === true;

  return (
    <Shell workspaces={workspaces} activeWorkspace={active}>
      <div className="flex flex-col gap-5">
        <header>
          <h1 className="label">Settings · Report mailbox</h1>
          <p className="mt-1.5 max-w-3xl text-[14px]" style={{ color: "var(--color-ink-2)" }}>
            One shared mailbox per workspace. Every domain points its rua tag at
            our reporting address: so no customer ever hands over IMAP
            credentials.
          </p>
        </header>
        <SettingsNav current="mailbox" />

        {/* The rua=https thread. A domain publishing reports to a web endpoint
            is configured but not collectable — this is how that is fixed. */}
        <section
          className="lift rounded-[2px] border px-5 py-4"
          style={{
            borderColor: "var(--color-unverified)",
            background: "var(--color-unverified-soft)",
          }}
          data-testid="rua-thread"
        >
          <p
            className="num text-[11px] font-semibold tracking-[0.12em] uppercase"
            style={{ color: "var(--color-unverified)" }}
          >
            Reports published to a web endpoint
          </p>
          <p className="mt-2 text-[13px] leading-relaxed" style={{ color: "var(--color-ink-2)" }}>
            If one of your domains publishes its reports to a web endpoint
            (common with Google, Microsoft and Yahoo) rather than a mailbox, its
            DMARC record is <strong style={{ color: "var(--color-ink)" }}>correctly
            configured</strong>: but this platform cannot read those reports yet,
            so that domain will show no report data. Fixing it means pointing the
            domain's <span className="num">rua=</span> tag at a mailbox collected
            here. The domain's setup screen says so too, and links back to this
            section.
          </p>
          <p className="mt-2 text-[12px]" style={{ color: "var(--color-ink-3)" }}>
            Leave the record as it is until you are ready: a domain showing
            "not collecting yet" is not a broken domain.
          </p>
        </section>

        {inbox ? (
          allowInbox ? (
            <ReportInboxForm organizationId={active.id} inbox={inbox} />
          ) : (
            <section
              className="lift rounded-[2px] border p-5"
              style={{ background: "var(--color-surface)", borderColor: "var(--color-line)" }}
              data-feature="reports.inbox"
            >
              <h2 className="text-[16px] font-semibold tracking-[-0.012em]">Report mailbox</h2>
              <p className="mt-2 text-[13.5px]" style={{ color: "var(--color-ink-2)" }}>
                The shared report mailbox is not included in your current plan.
              </p>
              <Link
                href="/billing"
                className="mt-2 inline-block text-[13px] font-semibold underline"
                style={{ color: "var(--color-ink)" }}
              >
                See plan options
              </Link>
            </section>
          )
        ) : null}
      </div>
    </Shell>
  );
}
