/**
 * openapi-paths/operations.ts — Routes added by the basic-operations audit (move, archive, restore, bulk, export).
 *
 * Spread into openapi.ts's paths. Use the helpers in ../openapi-helpers.ts.
 *
 * Every path here is a new key. openapi.ts spreads this object first and its own
 * keys after it, so a method added here under a path openapi.ts already
 * declares would be overwritten. That is why rename is `POST …/rename` rather
 * than a PATCH on the client or workspace path.
 */

import { apiErrors, errorResponse, idParam, idempotencyHeader, orgParam, standardErrors } from '../openapi-helpers.js';

const clientIdParam = idParam('clientId', 'Client identifier.');
const domainIdParam = idParam('domainId', 'Domain id or slug.');

const bulkResult = (doneKey: string, idsKey: string, reasons: string[]) => ({
  type: 'object',
  required: [doneKey, idsKey, 'skipped'],
  properties: {
    [doneKey]: { type: 'integer', description: 'How many were changed by this call.' },
    [idsKey]: { type: 'array', items: { type: 'string' } },
    skipped: {
      type: 'array',
      description: 'The ids that were not changed, each with the reason.',
      items: {
        type: 'object',
        required: ['id', 'reason'],
        properties: { id: { type: 'string' }, reason: { type: 'string', enum: reasons } },
      },
    },
  },
});

const reportAddressSchema = {
  type: 'object',
  required: ['previous', 'next', 'recordNamesPrevious', 'hosted'],
  properties: {
    previous: { type: 'string', description: 'The previous client report address (rua).' },
    next: { type: 'string', description: 'The new client report address, the one to publish in rua.' },
    recordNamesPrevious: {
      type: 'boolean',
      description: 'The DMARC record last read from DNS names the previous client address.',
    },
    hosted: { type: 'boolean', description: 'The DMARC record is served by hosted DMARC.' },
  },
};

const moveResultSchema = {
  type: 'object',
  required: ['moved', 'domain', 'from', 'to', 'shareLinksMoved', 'withdrawnProposals', 'reportAddress'],
  properties: {
    moved: { type: 'boolean', description: 'False when the domain was already under that client and nothing changed.' },
    domain: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        slug: { type: 'string' },
        clientId: { type: 'string' },
      },
    },
    from: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } } },
    to: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } } },
    shareLinksMoved: { type: 'integer' },
    withdrawnProposals: { type: 'integer' },
    reportAddress: reportAddressSchema,
  },
};

const moveBody = {
  required: true,
  content: {
    'application/json': {
      schema: {
        type: 'object',
        required: ['clientId'],
        properties: { clientId: { type: 'string', description: 'The client in this workspace to move the domain to.' } },
      },
    },
  },
};

const moveDescription = [
  'Moves the domain, with everything it owns, to another client in the same workspace: aggregate and forensic reports, scans, DNS changes, alert rules and events, digests, sender reviews and hosted records are keyed on the domain and move unchanged.',
  'Share links are moved to the new client too, so the public page names it. Pending approval requests were put to the previous client contacts, so they are withdrawn, each with its own audit row.',
  'From the next issue on, monthly reports include the domain under the new client; reports already issued stay with the client they were issued for. Open PSA tickets stay in the previous client PSA company.',
  'The DMARC record in DNS is not changed. When it names the previous client report address, reports keep arriving, because they are matched to the domain by name, but the record no longer proves this client owns the domain: reportAddress.next is the address to publish.',
  'Refused with 409 CONFLICT, and the blockers listed, while a provider switch is under way, because the switch planned its record around the previous client address.',
  'Moving a domain to the client it is already under answers 200 with moved false and writes nothing.',
].join(' ');

export const operationsPaths = {
  '/workspaces/{organizationId}/clients/export': {
    get: {
      tags: ['Clients and domains'],
      summary: 'Export the client book as CSV',
      description: [
        'Owner, admin, analyst or viewer. One row per domain, with the client name, slug, id and report address, the domain ownership state, DMARC policy, score and dates; a client with no domains is one row with the domain columns empty.',
        'For a PSA or CRM import, which wants the ids, and for a spreadsheet handed to a client. A cell that a spreadsheet would run as a formula is prefixed with a quote.',
        'The file name carries no product name, because a white-labelled agency hands it to its own clients. Recorded in the audit trail as EXPORT_DOWNLOADED with target client_book.',
      ].join(' '),
      parameters: [orgParam],
      responses: {
        200: {
          description: 'The CSV file, as an attachment.',
          content: { 'text/csv': { schema: { type: 'string' } } },
        },
        ...standardErrors,
      },
    },
  },
  '/workspaces/{organizationId}/clients/{clientId}/rename': {
    post: {
      tags: ['Clients and domains'],
      summary: 'Rename a client or change its slug',
      description: [
        'Owner or admin (client update). Send a new name, a new slug, or both.',
        'The client id, its report address, its Trust Center address and its domains do not change. An integration that looks the client up by slug needs the new one; the audit row (CLIENT_UPDATED) keeps both the old and the new values.',
        'A slug already used by another client in this workspace answers 409 CONFLICT. Sending the current values answers 200 with changed false.',
      ].join(' '),
      parameters: [orgParam, clientIdParam],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                name: { type: 'string', minLength: 2, maxLength: 100 },
                slug: { type: 'string', minLength: 2, maxLength: 60, pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$' },
              },
            },
          },
        },
      },
      responses: {
        200: {
          description: 'The client as it is now, and whether anything changed.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['client', 'changed'],
                properties: {
                  client: {
                    type: 'object',
                    properties: { id: { type: 'string' }, name: { type: 'string' }, slug: { type: 'string' } },
                  },
                  changed: { type: 'boolean' },
                },
              },
            },
          },
        },
        ...standardErrors,
      },
    },
  },
  '/workspaces/{organizationId}/domains/{domainId}/move-preview': {
    get: {
      tags: ['Clients and domains'],
      summary: 'Preview moving a domain to another client',
      description: [
        'Owner or admin (client update). What POST …/move would do, without doing it, so the confirmation can name what moves and what changes hands.',
        'Counts what travels with the domain (reports, forensic reports, scans, alert rules, open alerts, digests, live share links), lists every digest recipient (digests keep their recipients), counts the portal contacts who lose and gain sight of the domain, the pending approval requests that would be withdrawn, both clients monthly report schedules and PSA company mappings, and the open PSA tickets.',
        'reportAddress says whether the DMARC record last read from DNS names the previous client address and gives the new one. blockers lists what would refuse the move.',
      ].join(' '),
      parameters: [
        orgParam,
        domainIdParam,
        {
          name: 'clientId',
          in: 'query',
          required: true,
          description: 'The client to move the domain to.',
          schema: { type: 'string' },
        },
      ],
      responses: {
        200: { description: 'What the move would do.' },
        ...standardErrors,
      },
    },
  },
  '/workspaces/{organizationId}/domains/{domainId}/move': {
    post: {
      tags: ['Clients and domains'],
      summary: 'Move a domain to another client',
      description: `Owner or admin (client update). ${moveDescription} Recorded as DOMAIN_MOVED, naming both clients.`,
      parameters: [orgParam, domainIdParam],
      requestBody: moveBody,
      responses: {
        200: {
          description: 'Moved, or already there.',
          content: { 'application/json': { schema: moveResultSchema } },
        },
        ...standardErrors,
      },
    },
  },
  '/v1/domains/{domainId}/move': {
    post: {
      tags: ['API'],
      summary: 'Move a domain to another client',
      description: `For a PSA sync or a script that keeps each domain under the right client. Needs a key with the write scope. ${moveDescription} The audit row (DOMAIN_MOVED) carries the key id. Send Idempotency-Key so a retry after a timeout replays the first answer.`,
      security: [{ apiKeyAuth: [] }],
      parameters: [idParam('domainId', 'Domain id or slug, resolved inside the key workspace.'), idempotencyHeader],
      requestBody: moveBody,
      responses: {
        200: {
          description: 'Moved, or already there.',
          content: { 'application/json': { schema: moveResultSchema } },
        },
        ...apiErrors,
      },
    },
  },
  '/workspaces/{organizationId}/rename': {
    post: {
      tags: ['Lifecycle'],
      summary: 'Rename the workspace',
      description: [
        'Owner or admin (organization update). The name shows in the app, in invitation and alert emails, and to client portal contacts; the slug and the workspace id do not change.',
        'Recorded as WORKSPACE_UPDATED with the old and the new name. Sending the current name answers 200 with changed false.',
      ].join(' '),
      parameters: [orgParam],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['name'],
              properties: { name: { type: 'string', minLength: 2, maxLength: 80 } },
            },
          },
        },
      },
      responses: {
        200: { description: 'The workspace as it is now, and whether anything changed.' },
        ...standardErrors,
      },
    },
  },
  '/workspaces/{organizationId}/alerts/acknowledge': {
    post: {
      tags: ['Alerts'],
      summary: 'Acknowledge many alerts at once',
      description: [
        'Owner, admin or analyst (report update), the same right as acknowledging one. Up to 100 alert ids.',
        'Each alert goes through the same acknowledgement as the single route: its reminders stop, its PSA ticket gets a note, and it gets its own ALERT_ACKNOWLEDGED audit row with bulk true.',
        'Answered per alert: an alert already acknowledged or resolved is listed in skipped as already_handled, and an id that is not in this workspace as not_found. When none of the ids is in this workspace the answer is 404.',
      ].join(' '),
      parameters: [orgParam],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['eventIds'],
              properties: { eventIds: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string' } } },
            },
          },
        },
      },
      responses: {
        200: {
          description: 'Which alerts were acknowledged and which were skipped.',
          content: {
            'application/json': {
              schema: bulkResult('acknowledged', 'acknowledgedIds', ['not_found', 'already_handled']),
            },
          },
        },
        ...standardErrors,
        404: errorResponse('None of the ids is an alert in this workspace.'),
      },
    },
  },
  '/workspaces/{organizationId}/report-shares/revoke': {
    post: {
      tags: ['Onboarding and sharing'],
      summary: 'Revoke many share links at once',
      description: [
        'Owner, admin or analyst (report update), the same right as revoking one. Up to 100 share link ids.',
        'A revoked link stops working the next time it is opened, and its row stays so the list still shows what was sent; removing revoked rows is DELETE …/report-shares/revoked. Expired links are revoked too.',
        'Each revoked link gets its own REPORT_SHARE_REVOKED audit row with bulk true. A link already revoked is listed in skipped as already_revoked, and an id that is not in this workspace as not_found. When none of the ids is in this workspace the answer is 404.',
      ].join(' '),
      parameters: [orgParam],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['shareIds'],
              properties: { shareIds: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string' } } },
            },
          },
        },
      },
      responses: {
        200: {
          description: 'Which links were revoked and which were skipped.',
          content: {
            'application/json': {
              schema: bulkResult('revoked', 'revokedIds', ['not_found', 'already_revoked']),
            },
          },
        },
        ...standardErrors,
        404: errorResponse('None of the ids is a share link in this workspace.'),
      },
    },
  },
} as const;
