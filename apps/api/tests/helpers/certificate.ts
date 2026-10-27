import { generateKeyPairSync, sign } from 'node:crypto';

/**
 * Self-signed certificates, built at runtime.
 *
 * Nothing that looks like a private key or a certificate is committed: GitHub
 * push protection blocks a key block on sight, and a committed certificate is a
 * fixture that silently expires. These helpers assemble DER by hand and sign
 * with a key pair generated for the test, so every run starts clean.
 *
 * Shared by the unit and integration suites so both exercise the same fixture
 * the product would actually receive.
 */

function derLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  let value = length;
  while (value > 0) {
    bytes.unshift(value & 0xff);
    value >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLength(content.length), content]);
}

const sequence = (...parts: Buffer[]): Buffer => tlv(0x30, Buffer.concat(parts));
const set = (...parts: Buffer[]): Buffer => tlv(0x31, Buffer.concat(parts));
const utf8String = (value: string): Buffer => tlv(0x0c, Buffer.from(value, 'utf8'));
const nullValue = (): Buffer => Buffer.from([0x05, 0x00]);

function oid(dotted: string): Buffer {
  const parts = dotted.split('.').map(Number);
  const body: number[] = [40 * parts[0]! + parts[1]!];
  for (const part of parts.slice(2)) {
    if (part < 128) {
      body.push(part);
      continue;
    }
    const encoded: number[] = [];
    let value = part;
    while (value > 0) {
      encoded.unshift(value & 0x7f);
      value >>= 7;
    }
    for (let index = 0; index < encoded.length - 1; index += 1) {
      encoded[index] = encoded[index]! | 0x80;
    }
    body.push(...encoded);
  }
  return tlv(0x06, Buffer.from(body));
}

function utcTime(date: Date): Buffer {
  const iso = date.toISOString();
  const text = `${iso.slice(2, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
  return tlv(0x17, Buffer.from(text, 'ascii'));
}

function distinguishedName(commonName: string, organisation?: string): Buffer {
  const rdns: Buffer[] = [];
  if (organisation) {
    rdns.push(set(sequence(oid('2.5.4.10'), utf8String(organisation))));
  }
  rdns.push(set(sequence(oid('2.5.4.3'), utf8String(commonName))));
  return sequence(...rdns);
}

function extension(id: string, value: Buffer): Buffer {
  return sequence(oid(id), tlv(0x04, value));
}

function subjectAltNameExtension(names: string[]): Buffer {
  return extension('2.5.29.17', sequence(...names.map((name) => tlv(0x82, Buffer.from(name, 'ascii')))));
}

function extendedKeyUsageExtension(oids: string[]): Buffer {
  return extension('2.5.29.37', sequence(...oids.map((value) => oid(value))));
}

export interface SelfSignedInput {
  commonName: string;
  organisation?: string;
  names: string[];
  notBefore: Date;
  notAfter: Date;
  markCertificate?: boolean;
}

export function selfSignedPem(input: SelfSignedInput): string {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const spki = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  const algorithm = sequence(oid('1.2.840.113549.1.1.11'), nullValue());
  const extensions = [subjectAltNameExtension(input.names)];
  if (input.markCertificate) {
    extensions.push(extendedKeyUsageExtension(['1.3.6.1.5.5.7.3.31']));
  }

  const tbs = sequence(
    tlv(0xa0, tlv(0x02, Buffer.from([0x02]))),
    tlv(0x02, Buffer.from([0x01])),
    algorithm,
    distinguishedName(input.commonName, input.organisation),
    sequence(utcTime(input.notBefore), utcTime(input.notAfter)),
    distinguishedName(input.commonName, input.organisation),
    spki,
    tlv(0xa3, sequence(...extensions)),
  );
  const signature = sign('sha256', tbs, privateKey);
  const certificate = sequence(
    tbs,
    algorithm,
    tlv(0x03, Buffer.concat([Buffer.from([0x00]), signature])),
  );

  const body = certificate.toString('base64').match(/.{1,64}/g)!.join('\n');
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`;
}

/** A currently valid certificate for example.com, with the given overrides. */
export function certificateFor(overrides: Partial<SelfSignedInput> = {}): string {
  const now = Date.now();
  return selfSignedPem({
    commonName: 'example.com',
    organisation: 'Example Ltd',
    names: ['example.com'],
    notBefore: new Date(now - 24 * 60 * 60 * 1000),
    notAfter: new Date(now + 300 * 24 * 60 * 60 * 1000),
    ...overrides,
  });
}
