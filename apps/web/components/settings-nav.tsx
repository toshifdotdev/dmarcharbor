import Link from "next/link";

/**
 * settings-nav.tsx — the section nav shared by every settings page.
 *
 * Settings is NOT one long wall: each capability is its own section with its
 * own route, so a person landing on the section they care about can read it
 * end to end without scrolling past the rest.
 */

const SECTIONS: Array<{ key: string; href: string; label: string; blurb: string }> = [
  {
    key: "members",
    href: "/settings/members",
    label: "Members",
    blurb: "who can work in this workspace, and what each role may do",
  },
  {
    key: "sessions",
    href: "/settings/sessions",
    label: "Sessions",
    blurb: "every signed-in device: revoke anything you do not recognise",
  },
  {
    key: "slack",
    href: "/settings/slack",
    label: "Slack alerts",
    blurb: "deliver the alerts your rules already raise into a Slack channel",
  },
  {
    key: "mailbox",
    href: "/settings/mailbox",
    label: "Report mailbox",
    blurb: "the shared mailbox DMARC reports are collected from",
  },
  {
    key: "sso",
    href: "/settings/sso",
    label: "Single sign-on",
    blurb: "sign in through your own identity provider",
  },
  {
    key: "api-keys",
    href: "/settings/api-keys",
    label: "API keys",
    blurb: "keys for the public API, with read and write scopes",
  },
  {
    key: "export",
    href: "/settings/export",
    label: "Data export",
    blurb: "request a copy of the data held here: free on every plan",
  },
  {
    key: "erasure",
    href: "/settings/erasure",
    label: "Erasure",
    blurb: "irreversibly erase personal data: free on every plan",
  },
  {
    key: "compliance",
    href: "/settings/compliance",
    label: "Compliance",
    blurb: "issue the signed pack and publish the client Trust Center",
  },
  {
    key: "branding",
    href: "/settings/branding",
    label: "White label",
    blurb: "client-facing pages in your brand, not ours",
  },
];

export function SettingsNav({ current }: { current: string }) {
  return (
    <nav
      className="flex flex-wrap gap-1.5 border-b pb-3"
      style={{ borderColor: "var(--color-line)" }}
      aria-label="Settings sections"
    >
      {SECTIONS.map((s) => {
        const on = s.key === current;
        return (
          <Link
            key={s.key}
            href={s.href}
            aria-current={on ? "page" : undefined}
            className="rounded-[2px] border px-3 py-1.5 text-[12.5px] font-medium transition-colors"
            style={{
              borderColor: on ? "var(--color-accent)" : "var(--color-line-strong)",
              background: on ? "var(--color-accent-soft)" : "transparent",
              color: on ? "var(--color-ink)" : "var(--color-ink-3)",
            }}
          >
            {s.label}
          </Link>
        );
      })}
    </nav>
  );
}

export { SECTIONS };
