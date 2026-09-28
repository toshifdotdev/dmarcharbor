import { randomUUID } from 'node:crypto';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../../config/env.js';

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
 * The upload never touches this server. A presigned URL is issued after the
 * content type and size have been checked, and the browser PUTs straight to the
 * bucket. That removes binary handling, request body limits and memory pressure
 * from the API entirely, and it means the validation cannot be bypassed by
 * uploading a different file than the one that was approved.
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
  });

  return client;
}

export function logoStorageConfigured(): boolean {
  return Boolean(env.AWS_REGION && env.LOGO_BUCKET);
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
    ContentLength: checked.byteSize,
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
