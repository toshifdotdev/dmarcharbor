/**
 * CIDR maths for flattened SPF networks.
 *
 * Everything is stored as a bigint plus a prefix so IPv4 and IPv6 share one
 * containment test, and formatting goes back through the same canonical
 * helpers the rest of the product uses. Adjacent ranges are deliberately not
 * merged: merging them would change what the record authorises if the maths
 * were wrong, while leaving them separate is always safe.
 */

import { isIP } from 'node:net';
import { isNonPublicIp, normaliseIpAddress } from '../../senders/ip-intel.service.js';

export interface ParsedCidr {
  family: 4 | 6;
  /** Raw address bits, masked to the prefix. */
  bits: bigint;
  prefix: number;
}

function ipv6Groups(ip: string): string[] | null {
  const normalised = normaliseIpAddress(ip);
  if (!normalised) {
    return null;
  }
  const parts = normalised.split('::');
  if (parts.length > 2) {
    return null;
  }
  const head = parts[0] ? parts[0].split(':') : [];
  const tail = parts[1] ? parts[1].split(':') : [];
  const missing = normalised.includes('::') ? 8 - head.length - tail.length : 0;
  if (missing < 0) {
    return null;
  }
  const groups = [...head, ...Array.from({ length: missing }, () => '0'), ...tail];
  if (groups.length !== 8) {
    return null;
  }
  return groups.every((group) => /^[0-9a-f]{1,4}$/.test(group)) ? groups : null;
}

function addressBits(address: string, family: 4 | 6): bigint | null {
  if (family === 4) {
    const octets = address.split('.').map(Number);
    if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
      return null;
    }
    return octets.reduce((bits, octet) => (bits << 8n) | BigInt(octet), 0n);
  }

  const groups = ipv6Groups(address);
  if (!groups) {
    return null;
  }
  return groups.reduce((bits, group) => (bits << 16n) | BigInt(Number.parseInt(group, 16)), 0n);
}

export function parseCidr(text: string, family: 4 | 6): ParsedCidr | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed.includes(' ')) {
    return null;
  }
  const slash = trimmed.indexOf('/');
  const address = slash < 0 ? trimmed : trimmed.slice(0, slash);
  const prefixText = slash < 0 ? null : trimmed.slice(slash + 1);
  if (prefixText !== null && (prefixText.includes('/') || !/^\d+$/.test(prefixText))) {
    return null;
  }
  if (isIP(address) !== family) {
    return null;
  }
  const max = family === 4 ? 32 : 128;
  const prefix = prefixText === null ? max : Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) {
    return null;
  }
  const raw = addressBits(address, family);
  if (raw === null) {
    return null;
  }
  const hostBits = BigInt(max - prefix);
  const bits = hostBits === 0n ? raw : (raw >> hostBits) << hostBits;
  return { family, bits, prefix };
}

export function formatCidr(network: ParsedCidr): string {
  const { family, prefix } = network;
  let address: string;
  if (family === 4) {
    const a = Number((network.bits >> 24n) & 0xffn);
    const b = Number((network.bits >> 16n) & 0xffn);
    const c = Number((network.bits >> 8n) & 0xffn);
    const d = Number(network.bits & 0xffn);
    address = `${a}.${b}.${c}.${d}`;
  } else {
    const groups: string[] = [];
    for (let shift = 112n; shift >= 0n; shift -= 16n) {
      groups.push(((network.bits >> shift) & 0xffffn).toString(16));
    }
    const expanded = groups.join(':');
    address = normaliseIpAddress(expanded) ?? expanded;
  }
  const max = family === 4 ? 32 : 128;
  return prefix === max ? address : `${address}/${prefix}`;
}

function familyOf(value: string): 4 | 6 | null {
  const address = value.split('/')[0]!.trim();
  const family = isIP(address);
  return family === 4 || family === 6 ? family : null;
}

/** True when `outer` contains `inner` in the same family. */
function contains(outer: ParsedCidr, inner: ParsedCidr): boolean {
  if (outer.family !== inner.family || outer.prefix > inner.prefix) {
    return false;
  }
  const max = outer.family === 4 ? 32 : 128;
  const shift = BigInt(max - outer.prefix);
  return (outer.bits >> shift) === (inner.bits >> shift);
}

/**
 * Deduplicates and drops networks covered by a shorter prefix in the same
 * family. Input order is preserved, so the caller's source order stays
 * debuggable even though the final SPF content is sorted later.
 */
export function mergeNetworks(list: string[]): string[] {
  const parsed: ParsedCidr[] = [];
  const seen = new Set<string>();
  for (const value of list) {
    const family = familyOf(value);
    if (!family) {
      continue;
    }
    const network = parseCidr(value, family);
    if (!network) {
      continue;
    }
    const key = `${network.family}:${network.bits.toString()}:${network.prefix}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    parsed.push(network);
  }

  const kept = parsed.filter(
    (network) => !parsed.some((other) => other !== network && contains(other, network)),
  );
  return kept.map(formatCidr);
}

/** Uses the same reserved-range definition as sender intelligence. */
export function isPrivateOrReservedNetwork(network: ParsedCidr): boolean {
  const max = network.family === 4 ? 32 : 128;
  return isNonPublicIp(formatCidr({ ...network, prefix: max }));
}
