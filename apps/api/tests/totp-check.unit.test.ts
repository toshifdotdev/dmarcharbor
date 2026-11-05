import { describe, expect, it } from 'vitest';
import { hotp, totpKey, verifyTotp } from '../src/auth/totp-check.js';
import { membershipAuditEntry } from '../src/auth/membership-audit.js';
import { memberLimitMessage } from '../src/services/entitlements/entitlement.service.js';

/** RFC 4226 appendix D: the secret "12345678901234567890" in ASCII. */
const rfcKey = Buffer.from('12345678901234567890', 'ascii');

describe('the transfer confirmation code check', () => {
  it('matches the RFC 4226 test values', () => {
    expect([0, 1, 2, 3, 9].map((counter) => hotp(rfcKey, counter))).toEqual(['755224', '287082', '359152', '969429', '520489']);
  });

  it('reads a stored secret the way the plugin does: UTF-8, or base32 when prefixed', () => {
    expect(totpKey('12345678901234567890').equals(rfcKey)).toBe(true);
    // GEZDGNBVGY3TQOJQ... is base32 for the same twenty ASCII bytes.
    expect(totpKey('base32:GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ').equals(rfcKey)).toBe(true);
    expect(totpKey('base32:gezdgnbvgy3tqojqgezdgnbvgy3tqojq').equals(rfcKey)).toBe(true);
  });

  it('accepts the current step and one either side, and nothing further', () => {
    const now = 1_700_000_000_000;
    const step = Math.floor(now / 30_000);
    for (const offset of [-1, 0, 1]) {
      expect(verifyTotp(rfcKey, hotp(rfcKey, step + offset), now), `offset ${offset}`).toBe(true);
    }
    for (const offset of [-3, 3]) {
      const far = hotp(rfcKey, step + offset);
      const near = [-1, 0, 1].map((o) => hotp(rfcKey, step + o));
      if (!near.includes(far)) expect(verifyTotp(rfcKey, far, now), `offset ${offset}`).toBe(false);
    }
    expect(verifyTotp(rfcKey, '12345', now)).toBe(false);
    expect(verifyTotp(rfcKey, `${hotp(rfcKey, step)}9`, now)).toBe(false);
  });
});

describe('membership audit entries', () => {
  const session = { user: { id: 'actor-1' } };
  const invitation = { id: 'inv-1', email: 'alex@pellowyn-dental.example', role: 'analyst', organizationId: 'org-1' };

  it('tells an invitation from a resend by the resend flag', async () => {
    const sent = await membershipAuditEntry({
      path: '/organization/invite-member',
      body: { email: invitation.email, role: 'analyst' },
      context: { returned: invitation, session },
    });
    expect(sent).toMatchObject({ action: 'MEMBER_INVITED', actorUserId: 'actor-1', organizationId: 'org-1', targetId: 'inv-1' });
    const resent = await membershipAuditEntry({
      path: '/organization/invite-member',
      body: { email: invitation.email, role: 'analyst', resend: true },
      context: { returned: invitation, session },
    });
    expect(resent?.action).toBe('INVITATION_RESENT');
  });

  it('reads the invitation out of an accept or decline answer', async () => {
    const accepted = await membershipAuditEntry({
      path: '/organization/accept-invitation',
      context: { returned: { invitation, member: {} }, session },
    });
    expect(accepted).toMatchObject({ action: 'INVITATION_ACCEPTED', targetType: 'invitation', detail: { email: invitation.email } });
    const declined = await membershipAuditEntry({
      path: '/organization/reject-invitation',
      context: { returned: { invitation, member: null }, session },
    });
    expect(declined?.action).toBe('INVITATION_REJECTED');
  });

  it('writes nothing for a refused request or an unrelated path', async () => {
    expect(
      await membershipAuditEntry({ path: '/organization/invite-member', context: { returned: new Error('refused'), session } }),
    ).toBeNull();
    expect(await membershipAuditEntry({ path: '/organization/list-members', context: { returned: [], session } })).toBeNull();
    expect(await membershipAuditEntry({ path: '/organization/cancel-invitation', context: { returned: { nothing: true }, session } })).toBeNull();
  });
});

describe('the seat refusal sentence', () => {
  const allowance = { limit: 2, plan: 'MOORING' as const, planLabel: 'Mooring' };

  it('names the members it counted, with and without open invitations', () => {
    expect(memberLimitMessage({ ...allowance, members: 1, pending: 1 })).toMatch(/^Mooring includes 2 team members and this workspace has 1 member and 1 open invitation\. /);
    expect(memberLimitMessage({ ...allowance, members: 2, pending: 0 })).toMatch(/^Mooring includes 2 team members and this workspace has 2 members\. /);
    expect(memberLimitMessage({ ...allowance, limit: 5, members: 3, pending: 2 })).toContain('has 3 members and 2 open invitations.');
  });
});
