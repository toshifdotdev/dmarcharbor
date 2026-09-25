import { domainToASCII } from 'node:url';

const domainPattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

export class DomainValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DomainValidationError';
  }
}

export function normalizeDomain(input: string): string {
  const value = input.trim().toLowerCase().replace(/\.+$/, '');

  if (!value || /[\s/:?#@]/.test(value) || value.includes('..')) {
    throw new DomainValidationError('Enter a domain such as example.com.');
  }

  const asciiDomain = domainToASCII(value);

  if (!asciiDomain || !domainPattern.test(asciiDomain)) {
    throw new DomainValidationError('Enter a valid public domain such as example.com.');
  }

  if (asciiDomain === 'localhost' || asciiDomain.endsWith('.localhost') || asciiDomain.endsWith('.local')) {
    throw new DomainValidationError('Private or local domains cannot be scanned.');
  }

  return asciiDomain;
}
