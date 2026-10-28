import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  PsaConnectionError,
  deleteConnection,
  listJobs,
  listMappings,
  patchConnection,
  psaOptions,
  psaView,
  removeMapping,
  retryJob,
  saveConnection,
  searchPsaCompanies,
  setMapping,
  testConnection,
} from '../services/psa/psa-connection.service.js';
import type { PsaProviderName } from '../services/psa/provider.js';

const providerSchema = z.enum(['HALOPSA', 'CONNECTWISE', 'AUTOTASK']);

const credentialsSchema = z.record(z.string(), z.string().max(500)).default({});

const settingsSchema = z
  .object({
    ticketQueueId: z.string().max(64).nullable().optional(),
    ticketTypeId: z.string().max(64).nullable().optional(),
    openStatusId: z.string().max(64).nullable().optional(),
    closedStatusId: z.string().max(64).nullable().optional(),
    priorityId: z.string().max(64).nullable().optional(),
    closeOnResolve: z.boolean().optional(),
    ticketOnAlert: z.boolean().optional(),
    ticketOnCriticalDns: z.boolean().optional(),
  })
  .strict();

const saveSchema = z.object({
  provider: providerSchema,
  credentials: credentialsSchema,
  settings: settingsSchema.optional(),
});

const patchSchema = z
  .object({
    expectedVersion: z.coerce.number().int().min(1).optional(),
    enabled: z.boolean().optional(),
    settings: settingsSchema.optional(),
  })
  .refine((value) => value.enabled !== undefined || value.settings !== undefined, {
    message: 'Send settings or enabled.',
  });

const mappingSchema = z.object({
  externalCompanyId: z.string().trim().min(1).max(64),
  externalCompanyName: z.string().trim().min(1).max(200),
});

function actor(response: Response): string {
  return String(response.locals.session?.user?.id ?? '');
}

function fail(response: Response, error: unknown): void {
  if (error instanceof PsaConnectionError) {
    const { view, ...details } = error.details ?? {};
    response.status(error.status).json({
      error: { code: error.code, message: error.message, ...details },
      ...(view ? { view } : {}),
    });
    return;
  }
  throw error;
}

export async function getPsaController(request: Request, response: Response): Promise<void> {
  try {
    response.json(await psaView(String(request.params.organizationId)));
  } catch (error) {
    fail(response, error);
  }
}

export async function savePsaController(request: Request, response: Response): Promise<void> {
  const parsed = saveSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({
      error: {
        code: 'INVALID_REQUEST',
        message: 'Choose a provider, send its credentials, and optionally the ticket settings.',
      },
    });
    return;
  }
  try {
    response.json(
      await saveConnection({
        organizationId: String(request.params.organizationId),
        actorUserId: actor(response),
        provider: parsed.data.provider as PsaProviderName,
        credentials: parsed.data.credentials,
        settings: parsed.data.settings,
      }),
    );
  } catch (error) {
    fail(response, error);
  }
}

export async function patchPsaController(request: Request, response: Response): Promise<void> {
  const parsed = patchSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({
      error: { code: 'INVALID_REQUEST', message: 'Send settings, or enabled to pause or resume.' },
    });
    return;
  }
  try {
    response.json(
      await patchConnection({
        organizationId: String(request.params.organizationId),
        actorUserId: actor(response),
        expectedVersion: parsed.data.expectedVersion,
        enabled: parsed.data.enabled,
        settings: parsed.data.settings,
      }),
    );
  } catch (error) {
    fail(response, error);
  }
}

export async function deletePsaController(request: Request, response: Response): Promise<void> {
  try {
    await deleteConnection({
      organizationId: String(request.params.organizationId),
      actorUserId: actor(response),
    });
    response.status(204).end();
  } catch (error) {
    fail(response, error);
  }
}

export async function testPsaController(request: Request, response: Response): Promise<void> {
  try {
    response.json(await testConnection(String(request.params.organizationId)));
  } catch (error) {
    fail(response, error);
  }
}

export async function psaOptionsController(request: Request, response: Response): Promise<void> {
  try {
    response.json(await psaOptions(String(request.params.organizationId)));
  } catch (error) {
    fail(response, error);
  }
}

export async function psaCompaniesController(request: Request, response: Response): Promise<void> {
  const search = typeof request.query.search === 'string' ? request.query.search : '';
  try {
    response.json({ companies: await searchPsaCompanies(String(request.params.organizationId), search) });
  } catch (error) {
    fail(response, error);
  }
}

export async function listPsaMappingsController(request: Request, response: Response): Promise<void> {
  try {
    response.json({ mappings: await listMappings(String(request.params.organizationId)) });
  } catch (error) {
    fail(response, error);
  }
}

export async function setPsaMappingController(request: Request, response: Response): Promise<void> {
  const parsed = mappingSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({
      error: { code: 'INVALID_MAPPING', message: 'Choose a company from the PSA.' },
    });
    return;
  }
  try {
    response.json({
      mappings: await setMapping({
        organizationId: String(request.params.organizationId),
        actorUserId: actor(response),
        clientId: String(request.params.clientId),
        externalCompanyId: parsed.data.externalCompanyId,
        externalCompanyName: parsed.data.externalCompanyName,
      }),
    });
  } catch (error) {
    fail(response, error);
  }
}

export async function removePsaMappingController(request: Request, response: Response): Promise<void> {
  try {
    response.json({
      mappings: await removeMapping({
        organizationId: String(request.params.organizationId),
        actorUserId: actor(response),
        clientId: String(request.params.clientId),
      }),
    });
  } catch (error) {
    fail(response, error);
  }
}

export async function listPsaJobsController(request: Request, response: Response): Promise<void> {
  const limit = Number(request.query.limit ?? 50);
  try {
    response.json({
      jobs: await listJobs(
        String(request.params.organizationId),
        Number.isFinite(limit) ? limit : 50,
      ),
    });
  } catch (error) {
    fail(response, error);
  }
}

export async function retryPsaJobController(request: Request, response: Response): Promise<void> {
  try {
    await retryJob({
      organizationId: String(request.params.organizationId),
      actorUserId: actor(response),
      jobId: String(request.params.jobId),
    });
    response.json({
      jobs: await listJobs(String(request.params.organizationId), 50),
    });
  } catch (error) {
    fail(response, error);
  }
}
