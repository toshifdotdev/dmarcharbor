import { prisma } from '../../database/prisma.js';
import { encryptSensitive } from '../privacy.service.js';
import { callbackUrlsFor, ssoIdentifiersFor } from './sso-flow.service.js';

/**
 * Enterprise single sign on for a workspace.
 *
 * A workspace that already runs its people through an identity provider does not
 * want a second set of credentials to manage, and an auditor will ask why a
 * monitoring tool with access to every client's domain and forensic data is
 * reachable with a local password. This lets the workspace's own provider
 * vouch for the person instead.
 *
 * One connection belongs to one workspace and holds its own secret. A
 * connection is therefore never consulted across workspaces, so a tenant cannot
 * point at another tenant's IdP or replay a response meant for someone else.
 *
 * Just in time provisioning is the default because the alternative is an admin
 * maintaining a member list that drifts from the directory they already have.
 * It is bounded by an email domain allowlist, and that allowlist is the entire
 * security boundary: without one, anyone on the internet who can authenticate
 * to any IdP in the world would be able to provision themselves into the
 * workspace by claiming an email at a domain they do not control.
 */

export type SsoProtocol = 'SAML' | 'OIDC';
export type SsoProvisioningMode = 'JIT' | 'DISABLED';

/** Entitlement that unlocks this. Priced for Admiralty. */
export const SSO_ENTITLEMENT = 'auth.sso' as const;

export class SsoError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code = 'SSO_ERROR', status = 400) {
    super(message);
    this.name = 'SsoError';
    this.code = code;
    this.status = status;
  }
}

export interface NewSsoConnection {
  organizationId: string;
  label: string;
  protocol: SsoProtocol;
  /** SAML entity id, or the OIDC issuer. */
  issuer: string;
  /** SAML SSO url, or the OIDC authorization endpoint. */
  entryPoint: string;
  /** IdP public certificate for SAML signature checks. */
  idpCertificate?: string;
  /** OIDC token endpoint. */
  tokenEndpoint?: string;
  /** OIDC userinfo endpoint. */
  userinfoEndpoint?: string;
  clientId: string;
  clientSecret: string;
  provisioning: SsoProvisioningMode;
  /**
   * Email domains permitted to provision. Empty is refused for JIT.
   *
   * A connection with no domain allowlist is not a convenient default, it is an
   * open door, so this is validated at write time rather than at first login.
   */
  allowedEmailDomains: string[];
  defaultRole?: string;
}

/**
 * Normalises a domain for comparison.
 *
 * Lowercased and stripped of a leading @ and any trailing dot, because
 * `Example.COM.`, `@example.com` and `example.com` all name the same domain and
 * a comparison that treats them as different is a comparison that can be
 * evaded by typing a different case.
 */
export function normalizeEmailDomain(value: string): string {
  return value.trim().toLowerCase().replace(/^@/, '').replace(/\.+$/, '');
}

/** The domain part of an email address, lowercased. */
export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) {
    return null;
  }
  return normalizeEmailDomain(email.slice(at + 1));
}

/**
 * The names a verified client domain could be for this email domain to count
 * as proven: the domain itself and each parent with at least two labels.
 */
function proofCandidates(domain: string): string[] {
  const labels = domain.split('.').filter(Boolean);
  const candidates: string[] = [];
  for (let index = 0; index <= labels.length - 2; index += 1) {
    candidates.push(labels.slice(index).join('.'));
  }
  return candidates;
}

/**
 * The email domains this workspace has proved it controls.
 *
 * The allowlist alone used to be the boundary, and it checked only the shape
 * of a name. Any workspace on a plan with single sign-on could list
 * `victim-msp.example` (or `gmail.com`), point the connection at an identity
 * provider it runs, and have that provider assert any address there: an
 * existing account was attached through an invitation the same workspace had
 * created, and a new one was created as verified. Either way the session was
 * for someone else's account, with every workspace that account belongs to.
 *
 * A domain is proven when the workspace holds a VERIFIED client domain equal to
 * it or a parent of it. Verification is the DNS ownership check (the TXT token,
 * or a DMARC record naming the client's report address), so whoever passed it
 * controls the domain's DNS and with it the mail for its addresses. Domain
 * names are unique across workspaces, so no two workspaces can prove the same
 * one. Checked at sign-in, not only when the connection is saved, because a
 * domain can be removed or lose its verification afterwards.
 */
export async function provenEmailDomains(organizationId: string, domains: string[]): Promise<Set<string>> {
  const wanted = [...new Set(domains.map(normalizeEmailDomain).filter(Boolean))];
  const candidates = [...new Set(wanted.flatMap(proofCandidates))];
  if (candidates.length === 0) {
    return new Set();
  }
  const verified = await prisma.domain.findMany({
    where: { status: 'VERIFIED', name: { in: candidates }, client: { organizationId } },
    select: { name: true },
  });
  const held = new Set(verified.map((row) => row.name.toLowerCase()));
  return new Set(wanted.filter((domain) => proofCandidates(domain).some((candidate) => held.has(candidate))));
}

/** Refuses a sign-in whose email domain the workspace has not proved it controls. */
export async function assertEmailDomainProven(organizationId: string, domain: string): Promise<void> {
  const proven = await provenEmailDomains(organizationId, [domain]);
  if (!proven.has(normalizeEmailDomain(domain))) {
    throw new SsoError(
      'Single sign-on cannot admit this address yet. The workspace has to prove it controls this email domain first: an administrator adds the domain under a client and completes its ownership check.',
      'SSO_DOMAIN_NOT_VERIFIED',
      403,
    );
  }
}

function assertUsableDomains(domains: string[], provisioning: SsoProvisioningMode): string[] {
  const cleaned = [...new Set(domains.map(normalizeEmailDomain).filter(Boolean))];

  for (const domain of cleaned) {
    if (!domain.includes('.') || /\s/.test(domain)) {
      throw new SsoError(`"${domain}" is not a usable email domain.`, 'SSO_DOMAIN_INVALID');
    }
  }

  if (provisioning === 'JIT' && cleaned.length === 0) {
    // Refused rather than defaulted. An empty allowlist with provisioning on
    // would accept any address from any domain on the internet.
    throw new SsoError(
      'Just in time provisioning needs at least one permitted email domain.',
      'SSO_DOMAIN_REQUIRED',
    );
  }

  return cleaned;
}

export async function createSsoConnection(input: NewSsoConnection): Promise<{ id: string }> {
  const allowedEmailDomains = assertUsableDomains(input.allowedEmailDomains, input.provisioning);

  return prisma.ssoConnection.create({
    data: {
      organizationId: input.organizationId,
      label: input.label.trim().slice(0, 120),
      protocol: input.protocol,
      issuer: input.issuer.trim(),
      entryPoint: input.entryPoint.trim(),
      clientId: input.clientId.trim(),
      idpCertificate: input.idpCertificate?.trim() ?? null,
      tokenEndpoint: input.tokenEndpoint?.trim() ?? null,
      userinfoEndpoint: input.userinfoEndpoint?.trim() ?? null,
      // The client secret is account level access to the identity provider, so
      // it is encrypted with the same key as the mailbox password and is never
      // returned by any endpoint.
      clientSecretEncrypted: encryptSensitive(input.clientSecret),
      provisioning: input.provisioning,
      defaultRole: input.defaultRole?.trim() ?? 'analyst',
      connections: {
        create: allowedEmailDomains.map((domain) => ({ domain })),
      },
    },
    select: { id: true },
  });
}

export interface SsoConnectionView {
  id: string;
  label: string;
  protocol: SsoProtocol;
  issuer: string;
  entryPoint: string;
  clientId: string;
  /**
   * Where this provider must send the user back to, for both protocols.
   *
   * An administrator configuring an IdP cannot copy a value they were never given.
   * This is what the previous implementation computed and then threw away, which is
   * why the field was absent from the view while the service could produce it.
   */
  callbackUrls: { saml: string; oidc: string };
  /**
   * The values an IdP asks the service provider for, spelled out.
   *
   * The callback URL alone is not enough to configure either protocol. An
   * administrator is also asked for the entity id to put in the IdP, and for the
   * sign-in URL a user is sent to, and neither is derivable from the callback.
   *
   * `entityId` is this service acting as the service provider, so it is a
   * namespace we mint per connection rather than the IdP's own entity id, which
   * is what makes it stable across a certificate rotation. `loginUrl` is the IdP's
   * own entry point, returned verbatim: an administrator needs to see it to check
   * it, and it is not a secret.
   *
   * `idpEntityId` is the identifier the IdP expects to be given, which for SAML is
   * conventionally the issuer of the assertions it sends. Both are surfaced
   * because an IdP console will ask for one of them under a name nobody can guess
   * from the other.
   */
  entityId: string;
  idpEntityId: string;
  loginUrl: string;
  provisioning: SsoProvisioningMode;
  defaultRole: string;
  enabled: boolean;
  allowedEmailDomains: string[];
  /**
   * Listed domains the workspace has not proved it controls (no VERIFIED client
   * domain equal to or above them). Sign-in from these addresses is refused
   * until they are, so the screen says so rather than leaving a connection
   * that looks configured and admits nobody.
   */
  unverifiedEmailDomains: string[];
  createdAt: string;
}

/** Everything except the secret, for the agency interface. */
export async function listSsoConnections(organizationId: string): Promise<SsoConnectionView[]> {
  const rows = await prisma.ssoConnection.findMany({
    where: { organizationId },
    include: { connections: { select: { domain: true } } },
    orderBy: { createdAt: 'asc' },
  });
  const proven = await provenEmailDomains(
    organizationId,
    rows.flatMap((row) => row.connections.map((entry) => entry.domain)),
  );

  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    protocol: row.protocol,
    issuer: row.issuer,
    entryPoint: row.entryPoint,
    clientId: row.clientId,
    callbackUrls: callbackUrlsFor(row.id),
    ...ssoIdentifiersFor(row),
    provisioning: row.provisioning,
    defaultRole: row.defaultRole,
    enabled: row.enabled,
    allowedEmailDomains: row.connections.map((entry) => entry.domain).sort(),
    unverifiedEmailDomains: row.connections
      .map((entry) => entry.domain)
      .filter((domain) => !proven.has(normalizeEmailDomain(domain)))
      .sort(),
    createdAt: row.createdAt.toISOString(),
  }));
}

/**
 * Changes a connection in place: switch it off or on, rename it, change who
 * may join (allowlist, provisioning mode) and the role they arrive with.
 *
 * Deliberately not the identity provider details (issuer, entry point, client
 * id, secret, certificate). Those decide which provider is trusted, and a typo
 * there is fixed by adding a corrected connection and removing the old one, so
 * the trusted provider never changes underneath an existing session.
 *
 * The allowlist rule is the same one creation enforces: just in time
 * provisioning with no permitted domain is refused, whichever field changed.
 */
export async function updateSsoConnection(
  organizationId: string,
  connectionId: string,
  patch: {
    enabled?: boolean;
    label?: string;
    allowedEmailDomains?: string[];
    provisioning?: SsoProvisioningMode;
    defaultRole?: 'analyst' | 'viewer' | 'admin';
  },
): Promise<{ before: SsoConnectionView; after: SsoConnectionView }> {
  const existing = await prisma.ssoConnection.findFirst({
    where: { id: connectionId, organizationId },
    include: { connections: { select: { domain: true } } },
  });
  if (!existing) {
    throw new SsoError('No such connection in this workspace.', 'SSO_NOT_FOUND', 404);
  }

  const provisioning = patch.provisioning ?? existing.provisioning;
  const domains = assertUsableDomains(
    patch.allowedEmailDomains ?? existing.connections.map((entry) => entry.domain),
    provisioning,
  );

  await prisma.$transaction(async (tx) => {
    await tx.ssoConnection.update({
      where: { id: existing.id },
      data: {
        ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
        ...(patch.label === undefined ? {} : { label: patch.label.trim().slice(0, 120) }),
        ...(patch.provisioning === undefined ? {} : { provisioning: patch.provisioning }),
        ...(patch.defaultRole === undefined ? {} : { defaultRole: patch.defaultRole }),
      },
    });
    if (patch.allowedEmailDomains !== undefined) {
      await tx.ssoConnectionDomain.deleteMany({ where: { connectionId: existing.id } });
      if (domains.length > 0) {
        await tx.ssoConnectionDomain.createMany({ data: domains.map((domain) => ({ connectionId: existing.id, domain })) });
      }
    }
  });

  const views = await listSsoConnections(organizationId);
  const before = viewOf(existing, await provenEmailDomains(organizationId, existing.connections.map((entry) => entry.domain)));
  const after = views.find((view) => view.id === existing.id) ?? before;
  return { before, after };
}

function viewOf(row: {
  id: string;
  label: string;
  protocol: SsoProtocol;
  issuer: string;
  entryPoint: string;
  clientId: string;
  idpCertificate: string | null;
  provisioning: SsoProvisioningMode;
  defaultRole: string;
  enabled: boolean;
  createdAt: Date;
  connections: { domain: string }[];
}, proven: Set<string>): SsoConnectionView {
  return {
    id: row.id,
    label: row.label,
    protocol: row.protocol,
    issuer: row.issuer,
    entryPoint: row.entryPoint,
    clientId: row.clientId,
    callbackUrls: callbackUrlsFor(row.id),
    ...ssoIdentifiersFor(row),
    provisioning: row.provisioning,
    defaultRole: row.defaultRole,
    enabled: row.enabled,
    allowedEmailDomains: row.connections.map((entry) => entry.domain).sort(),
    unverifiedEmailDomains: row.connections
      .map((entry) => entry.domain)
      .filter((domain) => !proven.has(normalizeEmailDomain(domain)))
      .sort(),
    createdAt: row.createdAt.toISOString(),
  };
}

export async function deleteSsoConnection(organizationId: string, connectionId: string): Promise<void> {
  // Scoped to the organization in the delete itself, so a connection id from
  // another workspace removes nothing rather than reaching across tenants.
  const removed = await prisma.ssoConnection.deleteMany({ where: { id: connectionId, organizationId } });
  if (removed.count === 0) {
    throw new SsoError('No such connection in this workspace.', 'SSO_NOT_FOUND', 404);
  }
}

/**
 * Whether an address is usable by this connection at all.
 *
 * This checks the shape of the address and the domain allowlist, and nothing
 * else. The domain check lives here rather than in the flow handlers so the OIDC
 * and SAML paths cannot drift apart and end up with different rules.
 *
 * Whether a particular person may *join* is a different question and needs the
 * database, so it is answered in the flow where membership and invitations are
 * visible. It used to be answered here as well, and rejecting every address when
 * provisioning is disabled, which contradicted this function's own error message:
 * "only admits people who have already been invited" cannot be enforced by
 * refusing everybody, and in practice it locked every existing member out of a
 * connection an administrator had switched to invitation only.
 */
export function assertMayProvision(
  connection: { provisioning: SsoProvisioningMode; connections: { domain: string }[] },
  email: string,
): string {
  const domain = emailDomain(email);
  if (!domain) {
    throw new SsoError('That identity has no usable email address.', 'SSO_EMAIL_INVALID', 403);
  }

  const permitted = connection.connections.some((entry) => normalizeEmailDomain(entry.domain) === domain);
  if (!permitted) {
    // Deliberately does not say whether the domain is known, only that the
    // address is not accepted, so the error cannot be used to discover which
    // domains a workspace has registered.
    throw new SsoError('That email domain is not permitted for this connection.', 'SSO_DOMAIN_NOT_PERMITTED', 403);
  }

  return domain;
}
