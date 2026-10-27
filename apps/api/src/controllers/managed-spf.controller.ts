import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  ManagedSpfError,
  checkSpfDelegation,
  managedSpfView,
  previewManagedSpf,
  requestSpfRelease,
  startManagedSpf,
  updateManagedSpf,
} from '../services/hosted-dns/managed-spf.service.js';

const sourceSchema = z.object({
  kind: z.enum(['include', 'ip4', 'ip6', 'a', 'mx']),
  value: z.string().max(512),
});

const sourcesSchema = z.array(sourceSchema).max(30);
const allQualifierSchema = z.enum(['-all', '~all']);

const previewSchema = z.object({
  sources: sourcesSchema,
  allQualifier: allQualifierSchema,
});

const updateSchema = z.object({
  expectedVersion: z.coerce.number().int().min(1),
  sources: sourcesSchema,
  allQualifier: allQualifierSchema,
});

function actor(response: Response): string {
  return String(response.locals.session?.user?.id ?? '');
}

function fail(response: Response, error: unknown): void {
  if (error instanceof ManagedSpfError) {
    const { view, outcomes, ...details } = error.details ?? {};
    response.status(error.status).json({
      error: {
        code: error.code,
        message: error.message,
        ...details,
      },
      ...(view ? { view } : {}),
      ...(outcomes ? { outcomes } : {}),
    });
    return;
  }
  throw error;
}

export async function getManagedSpfController(request: Request, response: Response): Promise<void> {
  try {
    response.json(
      await managedSpfView(
        String(request.params.organizationId),
        String(request.params.domainId),
      ),
    );
  } catch (error) {
    fail(response, error);
  }
}

export async function startManagedSpfController(request: Request, response: Response): Promise<void> {
  try {
    response.status(201).json(
      await startManagedSpf({
        organizationId: String(request.params.organizationId),
        domainId: String(request.params.domainId),
        actorUserId: actor(response),
      }),
    );
  } catch (error) {
    fail(response, error);
  }
}

export async function previewManagedSpfController(request: Request, response: Response): Promise<void> {
  const parsed = previewSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({
      error: {
        code: 'INVALID_REQUEST',
        message: 'Send a list of sources and an all qualifier of -all or ~all.',
      },
    });
    return;
  }
  try {
    response.json(
      await previewManagedSpf({
        organizationId: String(request.params.organizationId),
        domainId: String(request.params.domainId),
        sources: parsed.data.sources,
        allQualifier: parsed.data.allQualifier,
      }),
    );
  } catch (error) {
    fail(response, error);
  }
}

export async function updateManagedSpfController(request: Request, response: Response): Promise<void> {
  const parsed = updateSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({
      error: {
        code: 'INVALID_REQUEST',
        message: 'Name the version you read, the sources and an all qualifier of -all or ~all.',
      },
    });
    return;
  }
  try {
    response.json(
      await updateManagedSpf({
        organizationId: String(request.params.organizationId),
        domainId: String(request.params.domainId),
        actorUserId: actor(response),
        expectedVersion: parsed.data.expectedVersion,
        sources: parsed.data.sources,
        allQualifier: parsed.data.allQualifier,
      }),
    );
  } catch (error) {
    fail(response, error);
  }
}

export async function checkManagedSpfController(request: Request, response: Response): Promise<void> {
  try {
    response.json(
      await checkSpfDelegation({
        organizationId: String(request.params.organizationId),
        domainId: String(request.params.domainId),
      }),
    );
  } catch (error) {
    fail(response, error);
  }
}

export async function releaseManagedSpfController(request: Request, response: Response): Promise<void> {
  try {
    response.json(
      await requestSpfRelease({
        organizationId: String(request.params.organizationId),
        domainId: String(request.params.domainId),
        actorUserId: actor(response),
      }),
    );
  } catch (error) {
    fail(response, error);
  }
}
