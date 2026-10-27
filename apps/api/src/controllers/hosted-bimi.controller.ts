import type { Request, Response } from 'express';
import {
  HostedBimiError,
  checkBimiDelegation,
  hostedBimiView,
  removeBimiCertificate,
  requestBimiRelease,
  startHostedBimi,
  uploadBimiCertificate,
  uploadBimiLogo,
} from '../services/hosted-dns/hosted-bimi.service.js';

function actor(response: Response): string {
  return String(response.locals.session?.user?.id ?? '');
}

/**
 * One error shape for every hosted BIMI route.
 *
 * A refusal that names what failed is the whole value of the upload endpoints:
 * `failed` is the list of SVG checks the person can act on, and it travels at
 * the top level beside the message so the panel can render a list rather than
 * a paragraph.
 */
function fail(response: Response, error: unknown): void {
  if (error instanceof HostedBimiError) {
    response.status(error.status).json({
      error: {
        code: error.code,
        message: error.message,
        ...(error.details ?? {}),
      },
    });
    return;
  }
  throw error;
}

export async function getHostedBimiController(request: Request, response: Response): Promise<void> {
  try {
    response.json(
      await hostedBimiView(String(request.params.organizationId), String(request.params.domainId)),
    );
  } catch (error) {
    fail(response, error);
  }
}

export async function startHostedBimiController(request: Request, response: Response): Promise<void> {
  try {
    response.status(201).json(
      await startHostedBimi({
        organizationId: String(request.params.organizationId),
        domainId: String(request.params.domainId),
        actorUserId: actor(response),
      }),
    );
  } catch (error) {
    fail(response, error);
  }
}

export async function uploadHostedBimiLogoController(request: Request, response: Response): Promise<void> {
  try {
    response.json(
      await uploadBimiLogo({
        organizationId: String(request.params.organizationId),
        domainId: String(request.params.domainId),
        actorUserId: actor(response),
        bytes: Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0),
      }),
    );
  } catch (error) {
    fail(response, error);
  }
}

export async function uploadHostedBimiCertificateController(
  request: Request,
  response: Response,
): Promise<void> {
  try {
    response.json(
      await uploadBimiCertificate({
        organizationId: String(request.params.organizationId),
        domainId: String(request.params.domainId),
        actorUserId: actor(response),
        bytes: Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0),
      }),
    );
  } catch (error) {
    fail(response, error);
  }
}

export async function deleteHostedBimiCertificateController(
  request: Request,
  response: Response,
): Promise<void> {
  try {
    response.json(
      await removeBimiCertificate({
        organizationId: String(request.params.organizationId),
        domainId: String(request.params.domainId),
        actorUserId: actor(response),
      }),
    );
  } catch (error) {
    fail(response, error);
  }
}

export async function checkHostedBimiController(request: Request, response: Response): Promise<void> {
  try {
    response.json(
      await checkBimiDelegation({
        organizationId: String(request.params.organizationId),
        domainId: String(request.params.domainId),
      }),
    );
  } catch (error) {
    fail(response, error);
  }
}

export async function releaseHostedBimiController(request: Request, response: Response): Promise<void> {
  try {
    response.json(
      await requestBimiRelease({
        organizationId: String(request.params.organizationId),
        domainId: String(request.params.domainId),
        actorUserId: actor(response),
        removeNow: request.body?.removeNow === true,
      }),
    );
  } catch (error) {
    fail(response, error);
  }
}
