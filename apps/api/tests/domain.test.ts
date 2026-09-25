import { describe, expect, it } from 'vitest';
import { DomainValidationError, normalizeDomain } from '../src/scanner/domain.js';

describe('normalizeDomain', () => {
  it('normalizes a valid domain', () => {
    expect(normalizeDomain(' Example.com. ')).toBe('example.com');
  });

  it('rejects URLs and paths', () => {
    expect(() => normalizeDomain('https://example.com/path')).toThrow(DomainValidationError);
  });

  it('rejects private and invalid domains', () => {
    expect(() => normalizeDomain('localhost')).toThrow(DomainValidationError);
    expect(() => normalizeDomain('example')).toThrow(DomainValidationError);
    expect(() => normalizeDomain('-bad.example.com')).toThrow(DomainValidationError);
  });
});
