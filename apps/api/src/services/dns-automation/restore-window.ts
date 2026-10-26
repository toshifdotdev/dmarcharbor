/**
 * How long a published DNS value may be restored.
 *
 * Kept in its own module so the hosted-DMARC service can read it without
 * importing publish.service, which imports the scanner and would close a cycle
 * through domain-scan.
 */
export const restoreWindowDays = 7;
