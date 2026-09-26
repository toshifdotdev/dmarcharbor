import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openApiDocument } from '../src/openapi.js';

const routesDirectory = join(process.cwd(), 'src', 'routes');

const routeRegistrationPattern =
  /\b([A-Za-z_$][\w$]*)\.(get|post|patch|put|delete)\(\s*'([^']+)'/g;

function normaliseExpressPath(path: string): string {
  return path.replace(/:[A-Za-z0-9_]+/g, (match) => `{${match.slice(1)}}`);
}

function isRouterIdentifier(name: string): boolean {
  return name === 'app' || name.toLowerCase().endsWith('router');
}

function discoverRoutes(): { method: string; documentedPath: string }[] {
  const files = readdirSync(routesDirectory).filter((name) => name.endsWith('.routes.ts'));
  const discovered: { method: string; documentedPath: string }[] = [];

  for (const file of files) {
    const source = readFileSync(join(routesDirectory, file), 'utf8');
    for (const match of source.matchAll(routeRegistrationPattern)) {
      if (!isRouterIdentifier(match[1])) {
        continue;
      }

      discovered.push({
        method: match[2].toUpperCase(),
        documentedPath: normaliseExpressPath(match[3]),
      });
    }
  }

  return discovered;
}

describe('OpenAPI contract', () => {
  it('declares a valid document with the required top level fields', () => {
    expect(openApiDocument.openapi).toBe('3.1.0');
    expect(openApiDocument.info.title).toBe('DMARC Harbor API');
    expect(openApiDocument.info.version).toBeTruthy();
    expect(Object.keys(openApiDocument.paths).length).toBeGreaterThan(20);
  });

  it('documents every route that the application registers', () => {
    const documented = new Set<string>();

    for (const [path, methods] of Object.entries(openApiDocument.paths)) {
      for (const method of Object.keys(methods)) {
        documented.add(`${method.toUpperCase()} ${path}`);
      }
    }

    const discovered = discoverRoutes();
    expect(discovered.length).toBeGreaterThan(20);

    const undocumented = discovered.filter((route) => !documented.has(`${route.method} ${route.documentedPath}`));

    expect(
      undocumented.map((route) => `${route.method} ${route.documentedPath}`),
    ).toEqual([]);
  });

  it('documents no path that the application does not register', () => {
    const discovered = new Set<string>();
    for (const route of discoverRoutes()) {
      discovered.add(`${route.method} ${route.documentedPath}`);
    }

    const systemPaths = new Set(['GET /health', 'GET /ready', 'GET /meta', 'GET /docs/openapi.json']);

    const extra = Object.entries(openApiDocument.paths)
      .flatMap(([path, methods]) =>
        Object.keys(methods).map((method) => `${method.toUpperCase()} ${path}`),
      )
      .filter((key) => !discovered.has(key) && !systemPaths.has(key));

    expect(extra).toEqual([]);
  });

  it('documents every error code the application can return', () => {
    const schema = openApiDocument.components.schemas.ApiError as unknown as {
      properties: { error: { properties: { code: { enum: readonly string[] } } } };
    };
    const codes = [...schema.properties.error.properties.code.enum].sort();

    expect(codes).toEqual([
      'CONFLICT',
      'FORBIDDEN',
      'INTERNAL',
      'INVALID_REQUEST',
      'NOT_FOUND',
      'RATE_LIMITED',
      'UNAUTHORIZED',
    ]);
  });

  it('documents the confirmation flag the identity toggle returns', () => {
    const errorSchema = openApiDocument.components.schemas.ApiError as unknown as {
      properties: { error: { properties: Record<string, { description?: string }> } };
    };

    expect(errorSchema.properties.error.properties.requiresNamePurgeConfirmation).toBeDefined();
  });

  it('marks every workspace path as documented with a description', () => {
    for (const [path, methods] of Object.entries(openApiDocument.paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        const record = operation as { summary?: string; description?: string };
        expect(record.summary, `${method} ${path} is missing a summary`).toBeTruthy();
        expect(record.description, `${method} ${path} is missing a description`).toBeTruthy();
      }
    }
  });
});
