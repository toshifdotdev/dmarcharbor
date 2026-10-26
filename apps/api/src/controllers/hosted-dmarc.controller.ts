import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  HostedDmarcError,
  changePolicy,
  checkDelegation,
  hostedDmarcView,
  requestRelease,
  restoreChange,
  startHosting,
} from '../services/hosted-dns/hosted-dmarc.service.js';

const policySchema = z.object({
  expectedVersion: z.coerce.number().int().min(1),
  policy: z.enum(['none', 'quarantine', 'reject']),
  testing: z.boolean().optional().default(false),
  np: z.enum(['none', 'quarantine', 'reject']).nullable().optional().default(null),
  override: z.boolean().optional().default(false),
  pct: z
    .unknown()
    .optional()
    .refine((value) => value === undefined, {
      message: 'pct was retired by RFC 9989. Use testing=true for testing mode (t=y).',
    }),
});

const restoreSchema = z.object({
  expectedVersion: z.coerce.number().int().min(1),
});

function actor(response: Response): string {
  return String(response.locals.session?.user?.id ?? '');
}

function fail(response: Response, error: unknown): void {
  if (error instanceof HostedDmarcError) {
    const { view, blockers, ...details } = error.details ?? {};
    response.status(error.status).json({
      error: {
        code: error.code,
        message: error.message,
        ...details,
      },
      // A 409 the caller has to act on carries the new state at the top level,
      // the same shape the DNS publish conflict uses.
      ...(view ? { view } : {}),
      ...(blockers ? { blockers } : {}),
    });
    return;
  }
  throw error;
}

export async function getHostedDmarcController(request: Request, response: Response): Promise<void> {
  try {
    response.json(
      await hostedDmarcView(
        String(request.params.organizationId),
        String(request.params.domainId),
      ),
    );
  } catch (error) {
    fail(response, error);
  }
}

export async function startHostedDmarcController(request: Request, response: Response): Promise<void> {
  try {
    response.status(201).json(
      await startHosting({
        organizationId: String(request.params.organizationId),
        domainId: String(request.params.domainId),
        actorUserId: actor(response),
      }),
    );
  } catch (error) {
    fail(response, error);
  }
}

export async function checkHostedDmarcController(request: Request, response: Response): Promise<void> {
  try {
    response.json(
      await checkDelegation({
        organizationId: String(request.params.organizationId),
        domainId: String(request.params.domainId),
      }),
    );
  } catch (error) {
    fail(response, error);
  }
}

export async function updateHostedDmarcController(request: Request, response: Response): Promise<void> {
  const parsed = policySchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({
      error: {
        code: 'INVALID_REQUEST',
        message: 'Choose a policy of none, quarantine or reject and name the version you read.',
      },
    });
    return;
  }
  try {
    response.json(
      await changePolicy({
        organizationId: String(request.params.organizationId),
        domainId: String(request.params.domainId),
        actorUserId: actor(response),
        expectedVersion: parsed.data.expectedVersion,
        policy: parsed.data.policy,
        testing: parsed.data.testing,
        np: parsed.data.np,
        override: parsed.data.override,
      }),
    );
  } catch (error) {
    fail(response, error);
  }
}

export async function restoreHostedDmarcController(request: Request, response: Response): Promise<void> {
  const parsed = restoreSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({
      error: { code: 'INVALID_REQUEST', message: 'Name the version you read.' },
    });
    return;
  }
  try {
    response.json(
      await restoreChange({
        organizationId: String(request.params.organizationId),
        domainId: String(request.params.domainId),
        changeId: String(request.params.changeId),
        actorUserId: actor(response),
        expectedVersion: parsed.data.expectedVersion,
      }),
    );
  } catch (error) {
    fail(response, error);
  }
}

export async function releaseHostedDmarcController(request: Request, response: Response): Promise<void> {
  try {
    response.json(
      await requestRelease({
        organizationId: String(request.params.organizationId),
        domainId: String(request.params.domainId),
        actorUserId: actor(response),
      }),
    );
  } catch (error) {
    fail(response, error);
  }
}
