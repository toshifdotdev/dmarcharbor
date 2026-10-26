/**
 * settings-map.ts — every settings section, how it is grouped, and the plain
 * phrases people use for what they came to do.
 *
 * Grouped by the job, not by our vocabulary. Somebody looking for "send alerts
 * to Slack" or "a client wants their data deleted" should find the section
 * without knowing it is called Slack destination or Erasure. The `tasks` are
 * those phrases: the settings index filters on them and Jump (Ctrl K) indexes
 * them, so both find the same section from the same words.
 *
 * `who` is the API's permission for changing the section, read from
 * apps/api/src/auth/permissions.ts and the route guards:
 *   anyone   every member (sessions are your own; audit is read-only)
 *   admin    owner and admin (organization:update, member/invitation)
 *   owner    owner only (organization:delete, billing:update)
 *
 * Pure data, safe on the server and in the browser.
 */

export type SettingsKey =
  | "workspace"
  | "members"
  | "sso"
  | "sessions"
  | "security"
  | "portal"
  | "branding"
  | "compliance"
  | "slack"
  | "webhooks"
  | "dns"
  | "api-keys"
  | "mailbox"
  | "audit"
  | "forensics"
  | "export"
  | "erasure";

export type Who = "anyone" | "admin" | "owner";

export interface SettingsSection {
  key: SettingsKey;
  href: string;
  label: string;
  /** The decision made here, in one line. */
  does: string;
  /** What people type when they are looking for it. */
  tasks: string[];
  who: Who;
  /** Holds an action that cannot be taken back. Marked in the directory. */
  irreversible?: boolean;
}

export interface SettingsGroup {
  id: string;
  title: string;
  lede: string;
  sections: SettingsSection[];
}

const s = (x: Omit<SettingsSection, "href"> & { href?: string }): SettingsSection => ({
  ...x,
  href: x.href ?? `/settings/${x.key}`,
});

export const SETTINGS_GROUPS: SettingsGroup[] = [
  {
    id: "people",
    title: "Workspace and people",
    lede: "Who is in this workspace, what each person may do, and how they sign in.",
    sections: [
      s({
        key: "workspace",
        label: "Workspace",
        does: "Its name, its plan and agreement, and deleting it with everything inside.",
        tasks: ["workspace id", "which plan are we on", "data processing agreement", "delete this workspace", "close the account"],
        who: "owner",
        irreversible: true,
      }),
      s({
        key: "members",
        label: "Members and roles",
        does: "Who can work here and what their role lets them change.",
        tasks: ["invite a colleague", "add a team member", "change someone's role", "remove someone", "who has access", "permissions"],
        who: "admin",
      }),
      s({
        key: "sso",
        label: "Single sign-on",
        does: "Sign in through your identity provider, and which email domains may.",
        tasks: ["sso", "saml", "oidc", "okta", "entra id", "azure ad", "google workspace", "restrict sign-in to our domain"],
        who: "admin",
      }),
      s({
        key: "sessions",
        label: "Signed-in devices",
        does: "Every device signed in as you, and signing any of them out.",
        tasks: ["sign out a lost laptop", "where am i signed in", "sign out everywhere", "sessions", "stolen device"],
        who: "anyone",
      }),
      s({
        key: "security",
        href: "/account/security",
        label: "Two-step verification",
        does: "The authenticator app that signs you in, and the backup codes for a lost phone.",
        tasks: ["2fa", "mfa", "two factor", "authenticator app", "backup codes", "require mfa", "lost my phone"],
        who: "anyone",
      }),
    ],
  },
  {
    id: "clients",
    title: "What your clients see",
    lede: "The pages and documents that leave this workspace with a client's name on them.",
    sections: [
      s({
        key: "portal",
        label: "Client portal access",
        does: "Which client contacts can sign in to a read-only view of their own domains.",
        tasks: ["give a client access", "client login", "client contact", "revoke a client's access", "portal"],
        who: "admin",
      }),
      s({
        key: "branding",
        label: "White label",
        does: "Your logo, colours and address on everything a client opens.",
        tasks: ["put our logo on client pages", "brand colours", "custom domain", "white label", "branding"],
        who: "admin",
      }),
      s({
        key: "compliance",
        label: "Trust Center and evidence packs",
        does: "A public trust page per client, and a signed PDF of their DMARC evidence.",
        tasks: ["send a client proof", "compliance pdf", "evidence pack", "trust page", "fingerprint", "auditor"],
        who: "admin",
      }),
    ],
  },
  {
    id: "connections",
    title: "Alerts and integrations",
    lede: "Where alerts and events go, and how your own systems talk to this one.",
    sections: [
      s({
        key: "slack",
        label: "Slack alerts",
        does: "One Slack channel that receives the alerts your rules raise.",
        tasks: ["send alerts to slack", "slack channel", "incoming webhook", "chat notifications"],
        who: "admin",
      }),
      s({
        key: "webhooks",
        label: "Webhooks",
        does: "Signed events posted to your own systems, and the record of each delivery.",
        tasks: ["send events to our system", "psa", "ticketing", "callback url", "retry a failed delivery", "integration"],
        who: "admin",
      }),
      s({
        key: "dns",
        label: "DNS publishing",
        does: "A Cloudflare connection that can publish the DNS records this service generates.",
        tasks: ["publish dns", "automatic dns", "connect cloudflare", "cloudflare", "dns integration"],
        who: "admin",
      }),
      s({
        key: "api-keys",
        label: "API keys",
        does: "Keys for the public API, and revoking one that has leaked. Only the owner issues them.",
        tasks: ["create an api token", "revoke a leaked key", "automate", "rest api", "integration key"],
        who: "admin",
      }),
      s({
        key: "mailbox",
        label: "Report mailbox",
        does: "A mailbox you run that DMARC reports are collected from.",
        tasks: ["collect reports from our mailbox", "imap", "rua address", "reports not arriving", "shared inbox"],
        who: "admin",
      }),
    ],
  },
  {
    id: "records",
    title: "Records and personal data",
    lede: "What happened here and who did it, and the data-protection requests clients send you.",
    sections: [
      s({
        key: "audit",
        label: "Audit trail",
        does: "Who changed what, when, and whether it was allowed.",
        tasks: ["who changed what", "who deleted", "activity log", "history", "security review"],
        who: "anyone",
      }),
      s({
        key: "forensics",
        label: "Forensic reports",
        does: "Per-message failure samples: collecting them, naming recipients, purging them.",
        tasks: ["failure samples", "ruf", "recipient addresses", "purge failure reports", "message samples"],
        who: "admin",
        irreversible: true,
      }),
      s({
        key: "export",
        label: "Data export",
        does: "A copy of the data held here, as JSON or CSV. Free on every plan.",
        tasks: ["download our data", "gdpr access request", "subject access", "csv", "json", "backup"],
        who: "anyone",
      }),
      s({
        key: "erasure",
        label: "Erasure",
        does: "Permanently erase personal data for the workspace, a client or a domain.",
        tasks: ["delete a client's personal data", "gdpr erasure", "right to be forgotten", "offboard a client", "delete data"],
        who: "owner",
        irreversible: true,
      }),
    ],
  },
];

export const SETTINGS_SECTIONS: SettingsSection[] = SETTINGS_GROUPS.flatMap((g) => g.sections);

export function settingsSection(key: SettingsKey): SettingsSection {
  const found = SETTINGS_SECTIONS.find((x) => x.key === key);
  if (!found) throw new Error(`Unknown settings section: ${key}`);
  return found;
}

export function settingsGroupOf(key: SettingsKey): SettingsGroup {
  return SETTINGS_GROUPS.find((g) => g.sections.some((x) => x.key === key)) ?? SETTINGS_GROUPS[0];
}

/** Better Auth stores multiple roles comma-separated; the strongest one wins. */
export function strongestRole(role: string | null | undefined): string | null {
  if (!role) return null;
  const roles = role.split(",").map((r) => r.trim());
  for (const r of ["owner", "admin", "analyst", "viewer", "portal"]) if (roles.includes(r)) return r;
  return roles[0] ?? null;
}

/** Whether a role may change a section that needs `who`. Unknown role: no. */
export function mayChange(role: string | null, who: Who): boolean {
  if (who === "anyone") return true;
  if (role === "owner") return true;
  return who === "admin" && role === "admin";
}
