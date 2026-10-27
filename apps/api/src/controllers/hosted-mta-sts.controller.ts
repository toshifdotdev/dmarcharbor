import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  HostedMtaStsError,
  changeMtaStsPolicy,
  checkMtaStsDelegation,
  hostedMtaStsView,
  requestMtaStsRelease,
  startHostedMtaSts,
} from '../services/hosted-dns/hosted-mta-sts.service.js';

const policySchema = z.object({
  expectedVersion: z.coerce.number().int().min(1),
  mode: z.enum(['testing', 'enforce']),
  mx: z.array(z.string().trim().min(1).max(253)).min(1).max(10),
  maxAge: z.coerce.number().int(),
  override: z.boolean().optional().default(false),
});

function actor(response: Response): string {
  return String(response.locals.session?.user?.id ?? '');
}

/**
 * One error shape for every hosted MTA-STS route.
 *
 * `blockers` travels at the top level on a POLICY_NOT_READY and `view` on a
 * version conflict, the same shape hosted DMARC uses, so the panel renders the
 * list rather than re-deriving it from a sentence.
 */
function fail(response: Response, error: unknown): void {
  if (error instanceof HostedMtaStsError) {
    const { view, blockers, ...details } = error.details ?? {};
    response.status(error.status).json({
      error: {
        code: error.code,
        message: error.message,
        ...details,
      },
      ...(view ? { view } : {}),
      ...(blockers ? { blockers } : {}),
    });
    return;
  }
  throw error;
}

export async function getHostedMtaStsController(request: Request, response: Response): Promise<void> {
  try {
    response.json(
      await hostedMtaStsView(String(request.params.organizationId), String(request.params.domainId)),
    );
  } catch (error) {
    fail(response, error);
  }
}

export async function startHostedMtaStsController(request: Request, response: Response): Promise<void> {
  try {
    response.status(201).json(
      await startHostedMtaSts({
        organizationId: String(request.params.organizationId),
        domainId: String(request.params.domainId),
        actorUserId: actor(response),
      }),
    );
  } catch (error) {
    fail(response, error);
  }
}

export async function checkHostedMtaStsController(request: Request, response: Response): Promise<void> {
  try {
    response.json(
      await checkMtaStsDelegation({
        organizationId: String(request.params.organizationId),
        domainId: String(request.params.domainId),
      }),
    );
  } catch (error) {
    fail(response, error);
  }
}

export async function updateHostedMtaStsController(request: Request, response: Response): Promise<void> {
  const parsed = policySchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({
      error: {
        code: 'INVALID_REQUEST',
        message:
          'Send the version you read, a mode of testing or enforce, one to ten MX hosts, and a max_age in seconds.',
      },
    });
    return;
  }
  try {
    response.json(
      await changeMtaStsPolicy({
        organizationId: String(request.params.organizationId),
        domainId: String(request.params.domainId),
        actorUserId: actor(response),
        expectedVersion: parsed.data.expectedVersion,
        mode: parsed.data.mode,
        mx: parsed.data.mx,
        maxAge: parsed.data.maxAge,
        override: parsed.data.override,
      }),
    );
  } catch (error) {
    fail(response, error);
  }
}

export async function releaseHostedMtaStsController(request: Request, response: Response): Promise<void> {
  try {
    response.json(
      await requestMtaStsRelease({
        organizationId: String(request.params.organizationId),
        domainId: String(request.params.domainId),
        actorUserId: actor(response),
      }),
    );
  } catch (error) {
    fail(response, error);
  }
}
