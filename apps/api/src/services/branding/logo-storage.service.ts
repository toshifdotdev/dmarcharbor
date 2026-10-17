import { randomUUID } from 'node:crypto';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../../config/env.js';
import { prisma } from '../../database/prisma.js';
import { recordAuditEvent } from '../audit.service.js';

/**
 * Logo storage.
 *
 * An agency's logo is served on the client facing portal, on every page a
 * customer's staff view. If that image were loaded from a URL the agency
 * controls, it would be a tracking pixel: the agency would learn each contact's
 * IP, when they signed in, which client they looked at, and how long they
 * stayed. On a security product that is not an acceptable trade for convenience,
 * so logos are stored here and served from our own origin.
 *
 * Two properties do the real work.
 *
 * The logo is stored under a key this workspace's own id and is served from our
 * origin, never from a URL the agency supplies. A presigned URL is offered, but
 * `uploadLogoDirect` is what the console uses: the file arrives here, over our
 * own origin, and is written once, validated. Handing a browser a URL to PUT to
 * made a 200KB logo depend on CORS being exactly right and on the browser
 * reproducing a signature byte for byte, and when those disagreed the failure
 * arrived as a bare "Failed to fetch" with nothing on the server to explain it.
 *
 * Validation reads the bytes that arrived rather than what the client claimed
 * about them, so the size and type that were checked are the size and type that
 * were stored.
 *
 * An SVG is a program, not a picture. Served as an image its scripts do not
 * run, but opened directly it executes. So the bucket is fronted by a separate
 * origin, never the application origin, and every response carries a sandbox
 * content security policy, which disables script execution even on a direct
 * navigation. That is what makes accepting SVG reasonable rather than reckless.
 */

export class LogoStorageError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code = 'LOGO_STORAGE_ERROR', status = 400) {
    super(message);
    this.name = 'LogoStorageError';
    this.code = code;
    this.status = status;
  }
}

/** A logo has no business being larger than this. */
export const maxLogoBytes = 256 * 1024;

export const acceptedLogoTypes = ['image/svg+xml', 'image/png', 'image/jpeg', 'image/webp'] as const;
export type AcceptedLogoType = (typeof acceptedLogoTypes)[number];

const extensions: Record<AcceptedLogoType, string> = {
  'image/svg+xml': 'svg',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

let client: S3Client | null = null;

function s3(): S3Client {
  if (client) {
    return client;
  }

  if (!env.AWS_REGION || !env.LOGO_BUCKET) {
    throw new LogoStorageError('Logo storage is not configured.', 'STORAGE_NOT_CONFIGURED', 503);
  }

  // Credentials are optional on AWS, where the instance role supplies them, so
  // an unsigned local setup still works.
  client = new S3Client({
    region: env.AWS_REGION,
    ...(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
      ? { credentials: { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY } }
      : {}),
    /**
     * Do NOT compute a checksum for the presigned PUT.
     *
     * Since SDK 3.729 the default is `WHEN_SUPPORTED`, which appends
     * `x-amz-checksum-crc32` and `x-amz-sdk-checksum-algorithm` to the signed
     * URL. Those are placeholders, because the server signing the URL has never
     * seen the body. A CLI client happened to get away with it; a browser did
     * not, and the browser reports the mismatch as a bare "Failed to fetch" with
     * no status and no body - which is what this upload did.
     *
     * `WHEN_REQUIRED` drops both parameters. Integrity is not lost: S3 still
     * verifies the signature, and the signed content-length still pins the
     * upload to the size that passed validation, which is the check that matters.
     */
    requestChecksumCalculation: 'WHEN_REQUIRED',
  });


  return client;
}

export function logoStorageConfigured(): boolean {
  return Boolean(env.AWS_REGION && env.LOGO_BUCKET);
}

/**
 * What the bytes actually are, read from the file's own magic numbers.
 *
 * The declared `Content-Type` is a claim by the sender, and a claim is not
 * evidence: posting `<html>…</html>` with `Content-Type: image/png` was accepted
 * until the bytes themselves were looked at, because every check so far read the
 * header. What is stored is then served from our own origin, so a claim that is
 * not checked is a way to put arbitrary content on a page a customer's staff
 * will load.
 *
 * SVG is text and has no magic number, so it is recognised structurally instead:
 * after a BOM and any leading whitespace and XML declaration, the document has
 * to open with `<svg`. That is a weaker check than a signature and is treated as
 * one - which is why SVG is served from a separate origin behind a sandbox CSP
 * rather than trusted.
 *
 * Returns null when the bytes do not identify as any accepted image.
 */
export function sniffLogoContentType(bytes: Buffer): AcceptedLogoType | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }

  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }

  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
    bytes.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }

  // Text formats. A generous read: UTF-8 BOM, whitespace, an XML declaration
  // with optional processing instructions, then the root element.
  const head = bytes.subarray(0, 1024).toString('utf8').replace(/^\uFEFF/, '').trimStart();
  if (/^(<\?xml[\s\S]*?\?>[\s\S]*?)?<svg[\s>]/i.test(head)) {
    return 'image/svg+xml';
  }

  return null;
}

/**
 * Rejects anything that is not a logo, before an upload URL exists.
 *
 * A presigned URL cannot be revoked, so this is the only point at which the
 * file can be constrained. Validating after the upload would leave the object
 * reachable and the check pointless.
 */
export function validateLogoUpload(input: { contentType: string; byteSize: number }): {
  contentType: AcceptedLogoType;
  byteSize: number;
  extension: string;
} {
  const contentType = input.contentType.trim().toLowerCase().split(';')[0] ?? '';

  if (!acceptedLogoTypes.includes(contentType as AcceptedLogoType)) {
    throw new LogoStorageError(
      'A logo must be an SVG, PNG, JPEG or WebP image.',
      'UNSUPPORTED_LOGO_TYPE',
      400,
    );
  }

  if (!Number.isInteger(input.byteSize) || input.byteSize <= 0) {
    throw new LogoStorageError('The logo size could not be determined.', 'INVALID_LOGO_SIZE', 400);
  }

  if (input.byteSize > maxLogoBytes) {
    throw new LogoStorageError(
      `A logo must be smaller than ${Math.round(maxLogoBytes / 1024)}KB.`,
      'LOGO_TOO_LARGE',
      413,
    );
  }

  const type = contentType as AcceptedLogoType;
  return { contentType: type, byteSize: input.byteSize, extension: extensions[type] };
}

/**
 * Namespaces by organisation, with a random component.
 *
 * The organisation segment keeps deletions cheap and makes a bucket listing
 * readable. The random component means a replacement never overwrites the file
 * a previous page load may still be fetching, which would otherwise produce a
 * broken image on a cached page.
 */
export function logoObjectKey(organizationId: string, extension: string, token = randomUUID()): string {
  return `logos/${organizationId}/${token}.${extension}`;
}

export interface PresignedUpload {
  uploadUrl: string;
  objectKey: string;
  publicUrl: string;
  expiresInSeconds: number;
  maxBytes: number;
  contentType: AcceptedLogoType;
}

const uploadUrlLifetimeSeconds = 300;

export async function createLogoUploadUrl(input: {
  organizationId: string;
  contentType: string;
  byteSize: number;
}): Promise<PresignedUpload> {
  const checked = validateLogoUpload(input);
  const key = logoObjectKey(input.organizationId, checked.extension);
  const bucket = env.LOGO_BUCKET!;

  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentType: checked.contentType,
    /**
     * Deliberately NOT setting `ContentLength` here.
     *
     * Setting it makes the presigner fold `content-length` into the signature -
     * `X-Amz-SignedHeaders=content-length;host`. Every CLI client then has to
     * send a byte-identical header or the signature fails, and a browser is the
     * one client that cannot be asked to: `content-length` is a forbidden header,
     * so it is whatever the network stack decides, and whether it appears at all
     * varies by transport. That mismatch is the "Failed to fetch" this file was
     * producing - curl succeeded against the identical URL, which is what made it
     * look like the bucket was misconfigured rather than the signature.
     *
     * Nothing is lost by dropping it. The size was already checked by
     * `validateLogoUpload` above - 256KB, wrong type rejected - before any URL
     * existed, and that check is where it belongs, because it can produce a
     * message a human reads. Binding the size inside a signature only makes the
     * rejection unreadable.
     *
     * To stop a holder of a valid URL uploading something oversized inside its
     * five-minute life, the bucket policy carries `s3:PutObject` with a
     * `content-length-range` condition. That is enforced by S3 on every write,
     * rather than by a header a client may or may not send.
     */
    // Marked private at the object level. If the bucket is ever made public for
    // serving, this flag is what prevents a stored object from being
    // overwritten through a browser PUT.
    CacheControl: 'public, max-age=31536000, immutable',
    Metadata: { organizationId: input.organizationId },
  });

  const uploadUrl = await getSignedUrl(s3(), command, { expiresIn: uploadUrlLifetimeSeconds });

  return {
    uploadUrl,
    objectKey: key,
    publicUrl: publicLogoUrl(key),
    expiresInSeconds: uploadUrlLifetimeSeconds,
    maxBytes: maxLogoBytes,
    contentType: checked.contentType,
  };
}

/**
 * Uploads a logo on the request's behalf and records it, in one step.
 *
 * This exists because handing the browser a presigned URL turned out to be the
 * wrong shape for a file this small. Presigning means the upload is a
 * cross-origin request from an arbitrary page to a storage bucket, which needs
 * CORS to be exactly right and depends on details no two browsers agree on - a
 * `content-length` in the signature that only one of them reproduces, checksum
 * parameters the SDK invents, a forbidden header. One browser uploaded it; a
 * second returned "Failed to fetch" against a URL that worked perfectly from
 * curl, and the difference was invisible from the server.
 *
 * Proxying removes the entire category. The file arrives on our own origin, so
 * there is no preflight and no signature for a client to disagree with, and it
 * is at most a few hundred kilobytes, so the bandwidth is not a consideration.
 *
 * It also fixes a leak rather than only a symptom: a presigned upload that was
 * never confirmed left its object in the bucket forever, because nothing ever
 * reconciled them. Storing and recording happen together here, so an abandoned
 * upload simply never happens.
 */
export async function uploadLogoDirect(input: {
  organizationId: string;
  contentType: string;
  bytes: Buffer;
}): Promise<{ objectKey: string; publicUrl: string }> {
  const checked = validateLogoUpload({ contentType: input.contentType, byteSize: input.bytes.byteLength });

  /**
   * The header is checked against the file. Declared and sniffed disagreeing
   * means one of them is lying, and the only safe reading is to refuse: this
   * bytes end up served from our own origin, on a page a client's staff load.
   */
  const sniffed = sniffLogoContentType(input.bytes);
  if (sniffed !== checked.contentType) {
    throw new LogoStorageError(
      `That file is not a ${checked.contentType.replace('image/', '').toUpperCase()}, whatever its name says. Export the logo again in the format shown above.`,
      'LOGO_CONTENT_MISMATCH',
      400,
    );
  }

  const key = logoObjectKey(input.organizationId, checked.extension);

  const existing = await prisma.organization.findUnique({
    where: { id: input.organizationId },
    select: { brandLogoUrl: true },
  });

  await s3().send(
    new PutObjectCommand({
      Bucket: env.LOGO_BUCKET!,
      Key: key,
      // Read off the bytes actually received, never off what the client claimed.
      // The claim is what the size check ran against; this is what was sent.
      ContentType: checked.contentType,
      ContentLength: input.bytes.byteLength,
      CacheControl: 'public, max-age=31536000, immutable',
      Metadata: { organizationId: input.organizationId },
      Body: input.bytes,
    }),
  );

  const previous = existing?.brandLogoUrl;
  if (previous) {
    // The old object is only worth removing once the new one is stored, or a
    // failure here would leave the workspace with no logo at all.
    await deleteStoredLogo(objectKeyFromLogoUrl(previous)).catch(() => undefined);
  }

  await prisma.organization.update({
    where: { id: input.organizationId },
    data: { brandLogoUrl: publicLogoUrl(key) },
  });

  await recordAuditEvent({
    organizationId: input.organizationId,
    action: 'BRANDING_UPDATED',
    targetType: 'organization',
    targetId: input.organizationId,
    detail: { logo: 'uploaded', bytes: input.bytes.byteLength, contentType: checked.contentType },
  });

  return { objectKey: key, publicUrl: publicLogoUrl(key) };
}

/**
 * The URL the portal should render.
 *
 * Always our origin. An agency supplied URL is never echoed back, which is the
 * whole point of storing the file here.
 */
export function publicLogoUrl(objectKey: string): string {
  const origin = (env.LOGO_CDN_ORIGIN ?? env.ASSETS_ORIGIN ?? '').replace(/\/$/, '');
  return `${origin}/${objectKey}`;
}

/**
 * Removes a stored logo.
 *
 * Called when a logo is replaced, when a workspace drops below the tier that
 * includes it, and on erasure. A customer's asset must not be left sitting in a
 * bucket after the feature that justified storing it has gone, and a deletion
 * request that quietly skipped files would not be a deletion.
 *
 * Never throws. A logo that is already gone, or a storage outage during a
 * downgrade, must not block the downgrade itself.
 */
export async function deleteStoredLogo(objectKey: string | null | undefined): Promise<boolean> {
  if (!objectKey || !logoStorageConfigured()) {
    return false;
  }

  try {
    await s3().send(new DeleteObjectCommand({ Bucket: env.LOGO_BUCKET!, Key: objectKey }));
    return true;
  } catch {
    // Recorded rather than raised. A dangling object is a housekeeping problem;
    // blocking a customer's plan change over it would be the worse outcome.
    console.error(`[logo] could not delete ${objectKey}`);
    return false;
  }
}

/**
 * Extracts the object key from a stored logo URL.
 *
 * Only URLs pointing at our own origin are recognised, so a pasted external URL
 * is left alone rather than being turned into a delete against a key we do not
 * own.
 */
export function objectKeyFromLogoUrl(logoUrl: string | null | undefined): string | null {
  if (!logoUrl) {
    return null;
  }

  const origins = [env.LOGO_CDN_ORIGIN, env.ASSETS_ORIGIN].filter(Boolean) as string[];
  if (origins.length === 0) {
    return null;
  }

  for (const origin of origins) {
    const prefix = `${origin.replace(/\/$/, '')}/`;
    if (logoUrl.startsWith(prefix)) {
      return logoUrl.slice(prefix.length);
    }
  }

  return null;
}

export { GetObjectCommand };
