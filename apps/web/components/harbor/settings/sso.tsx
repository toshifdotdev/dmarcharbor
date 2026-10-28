"use client";

/**
 * sso.tsx — single sign-on: who can get in through your identity provider.
 *
 * The allowlist of email domains is the whole security boundary of a
 * connection (sso-flow.service.ts): with just-in-time accounts on, anyone the
 * identity provider vouches for at an allowed domain becomes a member with the
 * default role. So each connection leads with who it lets in and as what, then
 * the values your identity provider needs, and removing one says who is locked
 * out.
 *
 * A connection can be switched off and on, and who may join through it changed
 * in place (PATCH). The provider details cannot: a corrected provider is a new
 * connection, so the trusted provider never changes under existing sessions.
 * There is no test endpoint. The secret is write-only; it is never returned and
 * never rendered after submit.
 *
 * Test hooks: inputs sit inside their <label> (label, issuer, entry, client id,
 * allowed email domains), the secret is the password input, "Add SSO
 * connection", sso-allowlist.
 */

import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import { createSsoConnection, removeSsoConnection, updateSsoConnection, type SsoCreateBody } from "@/lib/ops-client";
import type { SsoConnectionRow } from "@/lib/types";
import { ActionRefusal, type ActionError } from "@/components/harbor/plan-refusal";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch, Textarea } from "@/components/ui/choice";
import { CopyValue } from "@/components/ui/copy";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Input, Segmented, Select } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import { Panel } from "./parts";

/** A label that wraps its control, with the hint outside it. */
function Labelled({ label, hint, children, className }: { label: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={className}>
      <label className="flex flex-col gap-1.5">
        <span className="text-meta font-semibold text-fg-2">{label}</span>
        {children}
      </label>
      {hint ? <p className="mt-1 text-meta text-fg-3">{hint}</p> : null}
    </div>
  );
}

function bareOrigin(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && (u.pathname === "/" || u.pathname === "") && !u.search && !u.hash;
  } catch {
    return false;
  }
}

function Connection({
  c,
  canManage,
  paused,
  onRemove,
  organizationId,
}: {
  c: SsoConnectionRow;
  canManage: boolean;
  /** Removable only: switching and editing need the plan. */
  paused: boolean;
  onRemove: () => void;
  organizationId: string;
}) {
  const canEdit = canManage && !paused;
  const router = useRouter();
  const toast = useToast();
  const startUrl = c.callbackUrls.oidc.replace(/\/callback$/, "/start");
  const [busy, setBusy] = useState<"toggle" | "save" | null>(null);
  const [error, setError] = useState<ActionError | null>(null);
  const [editing, setEditing] = useState(false);
  const [domains, setDomains] = useState(c.allowedEmailDomains.join(", "));
  const [provisioning, setProvisioning] = useState<"JIT" | "DISABLED">(c.provisioning);
  const [defaultRole, setDefaultRole] = useState<"analyst" | "viewer" | "admin">(c.defaultRole);
  const domainList = domains
    .split(/[\s,;]+/)
    .map((d) => d.trim().replace(/^@/, "").toLowerCase())
    .filter(Boolean);

  async function toggle(next: boolean) {
    setBusy("toggle");
    setError(null);
    const res = await updateSsoConnection(organizationId, c.id, { enabled: next });
    setBusy(null);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    toast({ title: next ? `${c.label} is in use again` : `${c.label} is switched off`, body: next ? undefined : "Nobody can sign in through it until it is switched back on.", tone: "ok" });
    router.refresh();
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy("save");
    setError(null);
    const res = await updateSsoConnection(organizationId, c.id, { allowedEmailDomains: domainList, provisioning, defaultRole });
    setBusy(null);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setEditing(false);
    toast({ title: `Who can get in through ${c.label} is changed`, tone: "ok" });
    router.refresh();
  }

  return (
    <article className="flex flex-col gap-4 border-b border-rule pb-6 [animation:hb-rise_200ms_ease-out]">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h3 className="text-h3 font-bold text-fg">{c.label}</h3>
        <Badge tone="neutral" boxed>
          {c.protocol}
        </Badge>
        {paused ? (
          <Badge tone="warn">Not on this plan</Badge>
        ) : canEdit ? (
          <span className="flex items-center gap-2 text-ui text-fg-2">
            <Switch checked={c.enabled} onChange={toggle} busy={busy === "toggle"} label={`Use ${c.label} for sign-in`} />
            {c.enabled ? "In use" : "Switched off"}
          </span>
        ) : c.enabled ? (
          <Badge tone="ok">In use</Badge>
        ) : (
          <Badge tone="void">Switched off</Badge>
        )}
        <span className="flex-1" />
        {canManage ? (
          <Button size="sm" variant="ghost" className="text-fail hover:text-fail" onClick={onRemove}>
            Remove connection
          </Button>
        ) : null}
      </header>
      <ActionRefusal error={error} />

      <div data-testid="sso-allowlist" className="rounded-ctl border border-rule bg-paper-2 px-4 py-3">
        <p className="legend">Who can get in</p>
        <p className="mt-1 text-ui text-fg">
          {c.allowedEmailDomains.length > 0 ? (
            <>
              Addresses at{" "}
              {c.allowedEmailDomains.map((d, i) => (
                <span key={d}>
                  {i > 0 ? (i === c.allowedEmailDomains.length - 1 ? " and " : ", ") : null}
                  <code className="data font-semibold">{d}</code>
                </span>
              ))}
              .
            </>
          ) : (
            "No email domain is allowed, so nobody new can join through it."
          )}
        </p>
        <p className="mt-1 text-ui text-fg-2">
          {c.provisioning === "JIT"
            ? `Someone at an allowed domain with no account here gets one on their first sign-in, as ${/^[aeiou]/.test(c.defaultRole) ? "an" : "a"} ${c.defaultRole}. Remove a person from your identity provider to stop new sign-ins.`
            : "Only people who are already members, or hold a pending invitation, can sign in through it. Nobody is created automatically."}
        </p>
        {canEdit && !editing ? (
          <button type="button" className="link mt-2 text-meta" onClick={() => setEditing(true)}>
            Change who can get in
          </button>
        ) : null}
        {editing ? (
          <form onSubmit={save} className="mt-3 grid gap-3 border-t border-rule pt-3 md:grid-cols-2 [animation:hb-fade_120ms_ease-out]">
            <Labelled label="Allowed email domains" hint="Separate with commas." className="md:col-span-2">
              <Input mono value={domains} onChange={(e) => setDomains(e.target.value)} autoComplete="off" />
            </Labelled>
            <Labelled label="Who gets in">
              <Select value={provisioning} onChange={(e) => setProvisioning(e.target.value as "JIT" | "DISABLED")} className="w-full">
                <option value="JIT">Anyone at an allowed domain</option>
                <option value="DISABLED">Members and invited people only</option>
              </Select>
            </Labelled>
            <Labelled label="Role for people who join this way">
              <Select value={defaultRole} onChange={(e) => setDefaultRole(e.target.value as "analyst" | "viewer" | "admin")} className="w-full">
                <option value="viewer">viewer</option>
                <option value="analyst">analyst</option>
                <option value="admin">admin</option>
              </Select>
            </Labelled>
            <div className="flex flex-col gap-2 md:col-span-2">
              {provisioning === "JIT" && domainList.length === 0 ? (
                <p className="text-meta font-medium text-warn">Letting anyone in needs at least one allowed email domain.</p>
              ) : null}
              <p className="text-meta text-fg-3">
                Takes effect on the next sign-in. Existing members keep their access and their role.
              </p>
              <div className="flex items-center gap-3">
                <Button type="submit" size="sm" variant="primary" busy={busy === "save"} busyLabel="Saving">
                  Save
                </Button>
                <button
                  type="button"
                  className="link text-meta"
                  onClick={() => {
                    setEditing(false);
                    setDomains(c.allowedEmailDomains.join(", "));
                    setProvisioning(c.provisioning);
                    setDefaultRole(c.defaultRole);
                  }}
                >
                  Keep as it is
                </button>
              </div>
            </div>
          </form>
        ) : null}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <p className="legend">Give these to your identity provider</p>
          {c.protocol === "SAML" ? (
            <>
              <p className="text-meta text-fg-3">Assertion consumer service (ACS) URL</p>
              <CopyValue value={c.callbackUrls.saml} label="ACS URL" />
              <p className="text-meta text-fg-3">Service provider entity ID</p>
              <CopyValue value={c.entityId} label="entity ID" />
            </>
          ) : (
            <>
              <p className="text-meta text-fg-3">Redirect URI</p>
              <CopyValue value={c.callbackUrls.oidc} label="redirect URI" />
            </>
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          <p className="legend">Your team signs in at</p>
          <CopyValue value={startUrl} label="sign-in link" />
          <p className="text-meta text-fg-3">
            Issuer <code className="data text-fg-2">{c.idpEntityId}</code>
            <br />
            Client ID <code className="data text-fg-2">{c.clientId}</code>
          </p>
        </div>
      </div>
    </article>
  );
}

export function SsoBoard({
  organizationId,
  connections,
  canManage,
  paused = false,
}: {
  organizationId: string;
  connections: SsoConnectionRow[];
  canManage: boolean;
  /** The plan no longer includes SSO: connections can be read and removed, not added or changed. */
  paused?: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [protocol, setProtocol] = useState<"OIDC" | "SAML">("OIDC");
  const [label, setLabel] = useState("");
  const [issuer, setIssuer] = useState("");
  const [entryPoint, setEntryPoint] = useState("");
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const [domains, setDomains] = useState("");
  const [provisioning, setProvisioning] = useState<"JIT" | "DISABLED">("JIT");
  const [defaultRole, setDefaultRole] = useState<"analyst" | "viewer" | "admin">("analyst");
  const [cert, setCert] = useState("");
  const [tokenEndpoint, setTokenEndpoint] = useState("");
  const [userinfoEndpoint, setUserinfoEndpoint] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ActionError | null>(null);

  const [removing, setRemoving] = useState<SsoConnectionRow | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const domainList = domains
    .split(/[\s,;]+/)
    .map((d) => d.trim().replace(/^@/, "").toLowerCase())
    .filter(Boolean);
  const issuerProblem =
    issuer && !issuer.startsWith("https://")
      ? "The issuer must start with https://."
      : protocol === "OIDC" && issuer && !bareOrigin(issuer)
        ? "For OIDC, use the provider's base address with no path, for example https://accounts.example.com."
        : null;
  // Said once the form is under way, not at an empty form.
  const jitNeedsDomain = provisioning === "JIT" && domainList.length === 0 && Boolean(label || issuer || clientId);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const body: SsoCreateBody = {
      label: label.trim(),
      protocol,
      issuer: issuer.trim(),
      entryPoint: entryPoint.trim(),
      clientId: clientId.trim(),
      clientSecret: secret,
      provisioning,
      allowedEmailDomains: domainList,
      defaultRole,
      ...(protocol === "SAML" && cert.trim() ? { idpCertificate: cert.trim() } : {}),
      ...(protocol === "OIDC" && tokenEndpoint.trim() ? { tokenEndpoint: tokenEndpoint.trim() } : {}),
      ...(protocol === "OIDC" && userinfoEndpoint.trim() ? { userinfoEndpoint: userinfoEndpoint.trim() } : {}),
    };
    const res = await createSsoConnection(organizationId, body);
    setBusy(false);
    // The secret leaves the page either way: a refused submit is retyped.
    setSecret("");
    if (!res.ok) {
      setError(res.error);
      return;
    }
    toast({ title: `${body.label} is connected`, tone: "ok" });
    setLabel("");
    setIssuer("");
    setEntryPoint("");
    setClientId("");
    setDomains("");
    setCert("");
    setTokenEndpoint("");
    setUserinfoEndpoint("");
    router.refresh();
  }

  async function remove() {
    if (!removing) return;
    setRemoveBusy(true);
    setRemoveError(null);
    const res = await removeSsoConnection(organizationId, removing.id);
    setRemoveBusy(false);
    if (!res.ok && res.status !== 404) {
      setRemoveError(res.error.message ?? "The connection could not be removed.");
      return;
    }
    toast({ title: `${removing.label} is removed`, tone: "ok" });
    setRemoving(null);
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-10">
      {canManage && !paused ? (
        <Panel
          id="sso-add"
          title="Add a connection"
          why="Most providers offer both. OIDC is usually quicker to set up; choose SAML if your provider or policy requires it."
        >
          <form onSubmit={submit} className="grid max-w-[760px] gap-4 md:grid-cols-2">
            <Labelled label="Label" hint="What your team calls the provider: Okta, Entra ID, Google." className="md:col-span-2">
              <Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={120} required autoComplete="off" />
            </Labelled>
            <div className="md:col-span-2">
              <Segmented
                label="Protocol"
                value={protocol}
                onChange={setProtocol}
                options={[
                  { value: "OIDC", label: "OIDC" },
                  { value: "SAML", label: "SAML" },
                ]}
              />
            </div>
            <Labelled
              label="Issuer"
              hint={protocol === "OIDC" ? "The provider's base address, with no path." : "The identity provider's entity ID, as an https URL."}
            >
              <Input mono value={issuer} onChange={(e) => setIssuer(e.target.value)} required placeholder="https://idp.example.com" autoComplete="off" />
            </Labelled>
            <Labelled
              label={protocol === "OIDC" ? "Authorisation entry point" : "SSO entry point URL"}
              hint={protocol === "OIDC" ? "Where sign-in starts at the provider (the authorization endpoint)." : "Where the provider receives sign-in requests."}
            >
              <Input mono value={entryPoint} onChange={(e) => setEntryPoint(e.target.value)} required placeholder="https://idp.example.com/sso" autoComplete="off" />
            </Labelled>
            <Labelled label="Client ID" hint="The identifier your provider gave this application.">
              <Input mono value={clientId} onChange={(e) => setClientId(e.target.value)} required maxLength={300} autoComplete="off" />
            </Labelled>
            <Labelled label="Client secret" hint="Stored encrypted. It is never shown again, here or anywhere.">
              <Input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} required autoComplete="new-password" />
            </Labelled>
            <Labelled
              label="Allowed email domains"
              hint="Separate with commas. Only addresses at these domains can sign in through this connection."
              className="md:col-span-2"
            >
              <Input mono value={domains} onChange={(e) => setDomains(e.target.value)} placeholder="youragency.example, partner.example" autoComplete="off" />
            </Labelled>
            <Labelled label="Who gets in">
              <Select value={provisioning} onChange={(e) => setProvisioning(e.target.value as "JIT" | "DISABLED")} className="w-full">
                <option value="JIT">Anyone at an allowed domain</option>
                <option value="DISABLED">Members and invited people only</option>
              </Select>
            </Labelled>
            <Labelled label="Role for people who join this way" hint="Never owner: ownership is given by a person, not a directory.">
              <Select value={defaultRole} onChange={(e) => setDefaultRole(e.target.value as "analyst" | "viewer" | "admin")} className="w-full">
                <option value="viewer">viewer</option>
                <option value="analyst">analyst</option>
                <option value="admin">admin</option>
              </Select>
            </Labelled>
            {protocol === "SAML" ? (
              <Labelled label="Provider signing certificate" hint="PEM text. Used to check that assertions really come from your provider." className="md:col-span-2">
                <Textarea mono value={cert} onChange={(e) => setCert(e.target.value)} rows={4} placeholder="-----BEGIN CERTIFICATE-----" />
              </Labelled>
            ) : (
              <>
                <Labelled label="Token endpoint (optional)" hint="Only if your provider does not publish discovery.">
                  <Input mono value={tokenEndpoint} onChange={(e) => setTokenEndpoint(e.target.value)} autoComplete="off" />
                </Labelled>
                <Labelled label="Userinfo endpoint (optional)">
                  <Input mono value={userinfoEndpoint} onChange={(e) => setUserinfoEndpoint(e.target.value)} autoComplete="off" />
                </Labelled>
              </>
            )}
            <div className="flex flex-col gap-2 md:col-span-2">
              {issuerProblem ? <p className="text-meta font-medium text-fail">{issuerProblem}</p> : null}
              {jitNeedsDomain ? (
                <p className="text-meta font-medium text-warn">Letting anyone in needs at least one allowed email domain.</p>
              ) : null}
              {provisioning === "JIT" && defaultRole === "admin" ? (
                <p className="text-meta font-medium text-warn">
                  Everyone your provider admits at these domains becomes an admin: they can invite and remove people.
                </p>
              ) : null}
              <ActionRefusal error={error} />
              <div>
                <Button type="submit" variant="primary" busy={busy} busyLabel="Adding the connection">
                  Add SSO connection
                </Button>
              </div>
            </div>
          </form>
        </Panel>
      ) : null}

      <Panel
        id="sso-list"
        title="Connections"
        why="Switch a connection off to stop sign-ins without losing it. Who can get in is changed in place; the provider details are not: to correct them, add a new connection, check it works, then remove the old one."
        aside={`${connections.length}`}
      >
        {connections.length === 0 ? (
          <p className="text-ui text-fg-2">No connection yet. Everyone signs in with a password or a social account.</p>
        ) : (
          <div className="flex flex-col gap-6">
            {connections.map((c) => (
              <Connection
                key={c.id}
                organizationId={organizationId}
                c={c}
                canManage={canManage}
                paused={paused}
                onRemove={() => {
                  setRemoveError(null);
                  setRemoving(c);
                }}
              />
            ))}
          </div>
        )}
      </Panel>

      <ConfirmDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        onConfirm={remove}
        title={removing ? `Remove ${removing.label}?` : "Remove this connection?"}
        body={
          removing ? (
            <>
              <p>
                Nobody can sign in through {removing.label} from now on, and anyone whose only way in it was is locked out
                until they set a password or are given another way.
              </p>
              <p className="mt-2">Memberships are kept. Adding the connection again needs the client secret again.</p>
            </>
          ) : null
        }
        confirmLabel="Remove connection"
        busy={removeBusy}
        danger
        error={removeError}
      />
    </div>
  );
}
