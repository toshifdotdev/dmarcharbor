/**
 * openapi-paths/assistant.ts — Routes for the documentation assistant.
 *
 * Spread into openapi.ts's paths. Use the helpers in ../openapi-helpers.ts.
 */

import { errorResponse, orgParam, queryPagination, standardErrors } from '../openapi-helpers.js';

const source = {
  type: 'object',
  required: ['id', 'page', 'section', 'url'],
  properties: {
    id: { type: 'string', description: 'Stable section id, for example faq#getting-set-up/how-long-until-i-see-data.' },
    page: { type: 'string', description: 'The page as a reader names it: FAQ, Setup guide, Pricing, Refund Policy.' },
    section: { type: ['string', 'null'], description: 'The section on that page, or null for its opening.' },
    url: { type: 'string', description: 'Public path with the heading anchor, for example /faq#plans-and-billing.' },
  },
};

const support = {
  type: 'object',
  required: ['url', 'email'],
  properties: { url: { type: 'string' }, email: { type: 'string' } },
};

const plan402 = errorResponse(
  'FEATURE_NOT_IN_PLAN: the workspace plan does not carry assistant.docs (Harbor, Admiralty and Fleet do). The message names the plan that does.',
);

export const assistantPaths = {
  '/workspaces/{organizationId}/assistant': {
    get: {
      tags: ['Assistant'],
      summary: 'Starter questions and how the assistant answers here',
      description: [
        'What the in-product assistant needs before the first question: starter questions grouped by task, the support route, the longest question accepted and the limits.',
        'mode is written when a model provider is configured on this deployment and links when it is not; in links mode every answer is the matching documentation sections as links, with no generated text.',
        'Requires a staff role (billing read: owner, admin, analyst or viewer; never the client portal role) and the assistant.docs entitlement (Harbor, Admiralty and Fleet; 402 FEATURE_NOT_IN_PLAN otherwise).',
      ].join(' '),
      parameters: [orgParam],
      responses: {
        200: {
          description: 'The starters, mode, support route and limits.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['mode', 'starters', 'support', 'maxQuestionChars', 'limits'],
                properties: {
                  mode: { type: 'string', enum: ['written', 'links'] },
                  starters: {
                    type: 'array',
                    items: {
                      type: 'object',
                      required: ['task', 'questions'],
                      properties: { task: { type: 'string' }, questions: { type: 'array', items: { type: 'string' } } },
                    },
                  },
                  support,
                  maxQuestionChars: { type: 'integer' },
                  limits: {
                    type: 'object',
                    properties: { perMinute: { type: 'integer' }, perWorkspacePerDay: { type: 'integer' } },
                  },
                },
              },
            },
          },
        },
        402: plan402,
        ...standardErrors,
      },
    },
  },
  '/workspaces/{organizationId}/assistant/ask': {
    post: {
      tags: ['Assistant'],
      summary: 'Ask a question about the product',
      description: [
        'Answers a question about using the product from its own documentation (docs/: FAQ, setup guide, API documentation, legal pages) and the plan catalog, and from nothing else.',
        'The assistant receives the question text only: no workspace, client, domain, report or member data, the asker\'s own included, and it takes no actions.',
        'Before anything is sent or stored, email addresses, links, IP addresses, domain names and anything shaped like a key are replaced in the question.',
        'outcome is answered (a short written answer with the sections it cites in sources), unknown (message begins "I don\'t know": reason no_match when no section covers it, model_unsure when the model could not answer from the sections, or its answer was withheld because it cited nothing or stated a figure its sources do not), refused (outside the product: reason chit_chat, instructions, other_customer, workspace_data, legal_advice or other_vendor) or links_only (reason not_enabled when no provider is configured, provider_error when the provider failed; sources are the matching sections).',
        'Every reply carries the support route. followUps are up to two questions taken from the headings of the sections found. Unanswered questions are logged, redacted, with no user or workspace, for improving the docs.',
        'Rate limited per person per minute (ASSISTANT_RATE_LIMIT_PER_MINUTE, default 10) and per workspace per day (ASSISTANT_WORKSPACE_DAILY_LIMIT, default 200; only successful replies count). The same question three times in ten minutes is refused with 429 reason repeated.',
        'Requires a staff role (billing read) and the assistant.docs entitlement (Harbor, Admiralty and Fleet).',
      ].join(' '),
      parameters: [orgParam],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['question'],
              properties: {
                question: {
                  type: 'string',
                  description: 'The question, in a sentence. At most ASSISTANT_MAX_QUESTION_CHARS (default 500) characters.',
                },
              },
            },
          },
        },
      },
      responses: {
        200: {
          description: 'The reply.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['outcome', 'reason', 'answer', 'message', 'sources', 'sourcesLabel', 'followUps', 'support', 'mode', 'cached'],
                properties: {
                  outcome: { type: 'string', enum: ['answered', 'unknown', 'refused', 'links_only'] },
                  reason: {
                    type: ['string', 'null'],
                    description:
                      'Null when answered; otherwise no_match, model_unsure, provider_error, not_enabled, or the refusal kind.',
                  },
                  answer: { type: ['string', 'null'], description: 'The written answer, plain text, when outcome is answered.' },
                  message: { type: ['string', 'null'], description: 'The sentence to show for every other outcome.' },
                  sources: { type: 'array', items: source },
                  sourcesLabel: {
                    type: ['string', 'null'],
                    description: 'What the sources are: Sources, These pages look relevant, Pages that may help, or Closest pages.',
                  },
                  followUps: { type: 'array', items: { type: 'string' }, maxItems: 2 },
                  support,
                  mode: { type: 'string', enum: ['written', 'links'] },
                  cached: { type: 'boolean', description: 'True when the reply came from the cache of recent identical questions.' },
                },
              },
            },
          },
        },
        400: errorResponse('INVALID_REQUEST with reason empty, too_long, garbage or invalid.'),
        402: plan402,
        429: errorResponse('RATE_LIMITED with reason per_person, per_workspace_day or repeated.'),
        401: standardErrors[401],
        403: standardErrors[403],
      },
    },
  },
  '/staff/assistant/questions': {
    get: {
      tags: ['Assistant'],
      summary: 'Questions the assistant could not answer (staff)',
      description: [
        'For improving the documentation: each question the assistant did not answer, newest first, with why (no_match, model_unsure, refused or provider_error), the ids of the closest sections, and when.',
        'Rows hold no user, workspace, email or address, and the question text was redacted before it was stored. They are deleted after ASSISTANT_QUESTION_RETENTION_DAYS (default 180).',
        'Authorised by the deployment STAFF_API_KEY as a bearer token, not by a workspace role; answers 404 when no staff key is configured. Filter with ?reason=; paged with limit and cursor.',
      ].join(' '),
      security: [{ staffKey: [] }],
      parameters: [
        {
          name: 'reason',
          in: 'query',
          required: false,
          description: 'Only questions unanswered for this reason.',
          schema: { type: 'string', enum: ['no_match', 'model_unsure', 'refused', 'provider_error'] },
        },
        ...queryPagination,
      ],
      responses: {
        200: {
          description: 'A page of unanswered questions.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['items', 'hasMore', 'nextCursor'],
                properties: {
                  items: {
                    type: 'array',
                    items: {
                      type: 'object',
                      required: ['id', 'question', 'reason', 'closestSourceIds', 'createdAt'],
                      properties: {
                        id: { type: 'string' },
                        question: { type: 'string' },
                        reason: { type: 'string' },
                        closestSourceIds: { type: 'array', items: { type: 'string' } },
                        createdAt: { type: 'string', format: 'date-time' },
                      },
                    },
                  },
                  hasMore: { type: 'boolean' },
                  nextCursor: { type: ['string', 'null'] },
                },
              },
            },
          },
        },
        400: errorResponse('reason, limit or cursor is invalid.'),
        403: errorResponse('The bearer token is not the staff key.'),
        404: errorResponse('No staff key is configured on this deployment.'),
      },
    },
  },
} as const;
