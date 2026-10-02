import { describe, it, expect } from 'vitest';
import { resolveProviderAvailability } from '../src/auth/providers.js';

describe('provider availability', () => {
  it('offers password sign-in unconditionally', () => {
    const availability = resolveProviderAvailability({});
    expect(availability.password).toBe(true);
  });

  it('hides a social provider whose OAuth application is not registered', () => {
    // The development and production answers genuinely differ here, which is the
    // whole reason this endpoint exists rather than a hardcoded list in the UI.
    const availability = resolveProviderAvailability({});
    expect(availability.google).toBe(false);
    expect(availability.microsoft).toBe(false);
  });

  it('hides a provider that has a client id but no secret', () => {
    // A half-finished OAuth setup is not a working provider. Showing the button
    // would send the customer to a redirect that cannot complete.
    const availability = resolveProviderAvailability({
      googleClientId: 'id.apps.googleusercontent.com',
    });
    expect(availability.google).toBe(false);
  });

  it('shows a provider once both halves of its OAuth application exist', () => {
    const availability = resolveProviderAvailability({
      googleClientId: 'id.apps.googleusercontent.com',
      googleClientSecret: 'secret',
    });
    expect(availability.google).toBe(true);
    expect(availability.microsoft).toBe(false);
  });

  it('never leaks credential material in the answer', () => {
    const availability = resolveProviderAvailability({
      googleClientId: 'id.apps.googleusercontent.com',
      googleClientSecret: 'super-secret-value',
    });
    expect(JSON.stringify(availability)).not.toContain('super-secret-value');
    expect(JSON.stringify(availability)).not.toContain('apps.googleusercontent.com');
    expect(Object.values(availability).every((value) => typeof value === 'boolean')).toBe(true);
  });
});