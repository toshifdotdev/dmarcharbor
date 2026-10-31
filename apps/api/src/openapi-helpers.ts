/**
 * openapi-helpers.ts — the shared pieces of the contract (error responses,
 * path parameters, pagination), used by openapi.ts and the per-area files in
 * openapi-paths/. Kept apart from openapi.ts so those files can import them
 * without a circular import.
 */

export const errorResponse = (description: string) => ({
  description,
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/ApiError' },
    },
  },
});

export const paginated = (itemSchema: Record<string, unknown>) => ({
  type: 'object',
  required: ['items', 'hasMore', 'nextCursor'],
  properties: {
    items: { type: 'array', items: itemSchema },
    hasMore: { type: 'boolean' },
    nextCursor: { type: ['string', 'null'] },
  },
});

export const idParam = (name: string, description: string) => ({
  name,
  in: 'path',
  required: true,
  description,
  schema: { type: 'string' },
});

export const orgParam = idParam('organizationId', 'Workspace identifier from the URL.');

export const connectionParam = idParam('connectionId', 'The identity provider connection to use.');

export const queryPagination = [
  {
    name: 'limit',
    in: 'query',
    required: false,
    description: 'Rows to return, 1 to 200. Defaults to 50.',
    schema: { type: 'integer', minimum: 1, maximum: 200 },
  },
  {
    name: 'cursor',
    in: 'query',
    required: false,
    description: 'Cursor from a previous response, used to fetch the next page.',
    schema: { type: 'string', maxLength: 64 },
  },
];

export const standardErrors = {
  400: errorResponse('The request body or query parameters are invalid.'),
  401: errorResponse('Authentication is required.'),
  403: errorResponse('The signed-in user lacks the required workspace role.'),
  404: errorResponse('The resource does not exist in this workspace.'),
  409: errorResponse('The request conflicts with the current state, or needs a confirmation flag.'),
  429: errorResponse('Rate limit exceeded.'),
};

/**
 * The errors a `/v1` route can answer with.
 *
 * Separate from `standardErrors` because the meanings are different: 403 on a
 * browser route is "your role", and on `/v1` it is "this key's scope". A caller
 * reading the contract should not have to translate.
 */
export const apiErrors = {
  400: errorResponse('The request body or query parameters are invalid.'),
  401: errorResponse('No API key, or a key that is invalid, revoked or expired.'),
  402: errorResponse('The workspace plan does not carry the feature this route reads.'),
  403: errorResponse('The key does not carry the scope this route needs (write).'),
  404: errorResponse(
    'The resource is not in this key workspace. A resource in another workspace answers the same way, so the response cannot be used to discover what exists elsewhere.',
  ),
  409: errorResponse('The request conflicts with the current state of the resource.'),
  429: errorResponse('Rate limit exceeded, either for this key or for this client address.'),
};

/**
 * `Idempotency-Key` on every v1 write.
 *
 * A retried request replays the original response and sets
 * `Idempotency-Replayed: true`. Reusing a key with a different body is a 409
 * `IDEMPOTENCY_KEY_REUSED` rather than a silent replay of the wrong answer.
 */
export const idempotencyHeader = {
  name: 'Idempotency-Key',
  in: 'header',
  required: false,
  description:
    'Any stable string, for example a ticket id. A retry with the same key and body replays the original response instead of repeating the write.',
  schema: { type: 'string', minLength: 1, maxLength: 200 },
};

export const domainRefParam = idParam(
  'domain',
  'Domain id or slug. Both are accepted, and both are resolved inside the key workspace.',
);

export const apiListResponse = (resource: string, description: string) => ({
  description,
  content: {
    'application/json': {
      schema: {
        type: 'object',
        required: [resource, 'nextCursor'],
        properties: {
          [resource]: { type: 'array', items: { type: 'object' } },
          nextCursor: {
            type: ['string', 'null'],
            description: 'Pass back as ?cursor= for the next page. Null on the last page.',
          },
        },
      },
    },
  },
});
