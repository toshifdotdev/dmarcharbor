const errorResponse = (description: string) => ({
  description,
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/ApiError' },
    },
  },
});

const paginated = (itemSchema: Record<string, unknown>) => ({
  type: 'object',
  required: ['items', 'hasMore', 'nextCursor'],
  properties: {
    items: { type: 'array', items: itemSchema },
    hasMore: { type: 'boolean' },
    nextCursor: { type: ['string', 'null'] },
  },
});

const idParam = (name: string, description: string) => ({
  name,
  in: 'path',
  required: true,
  description,
  schema: { type: 'string' },
});

const orgParam = idParam('organizationId', 'Workspace identifier from the URL.');

const queryPagination = [
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

const standardErrors = {
  400: errorResponse('The request body or query parameters are invalid.'),
  401: errorResponse('Authentication is required.'),
  403: errorResponse('The signed-in user lacks the required workspace role.'),
  404: errorResponse('The resource does not exist in this workspace.'),
  409: errorResponse('The request conflicts with the current state, or needs a confirmation flag.'),
  429: errorResponse('Rate limit exceeded.'),
};

export const openApiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'DMARC Harbor API',
    version: '1.0.0',
    description: [
      'Backend for the DMARC Harbor agency product.',
      '',
      'Conventions:',
      '- Every list endpoint returns { items, hasMore, nextCursor }.',
      '- Every error returns { error: { code, message } } with one of the documented codes.',
      '- Paths containing :organizationId are always scoped to that workspace.',
      '- The caller role is listed per endpoint; roles are owner, admin, analyst, viewer.',
    ].join('\n'),
  },
  servers: [{ url: '/api', description: 'API root' }],
  tags: [
    { name: 'System' },
    { name: 'Auth' },
    { name: 'Clients and domains' },
    { name: 'Scanning' },
    { name: 'Reports' },
    { name: 'Forensics' },
    { name: 'Alerts' },
    { name: 'Notifications' },
    { name: 'Onboarding and sharing' },
    { name: 'Billing' },
  ],
  paths: {
    '/health': {
      get: {
        tags: ['System'],
        summary: 'Liveness check',
        description: 'Returns ok whenever the process is running. Makes no dependency calls.',
        responses: { 200: { description: 'Process is alive.' } },
      },
    },
    '/ready': {
      get: {
        tags: ['System'],
        summary: 'Readiness check',
        description: 'Verifies the database answers within 3 seconds. Returns 503 when it does not.',
        responses: {
          200: { description: 'Process can serve traffic.' },
          503: { description: 'A dependency is unavailable.' },
        },
      },
    },
    '/meta': {
      get: {
        tags: ['System'],
        summary: 'Runtime configuration',
        description: [
          'Effective retention windows, alerting intervals and the full plan catalog, for the UI to display.',
          'Include the catalog in the pricing page so the interface can show correct upgrade prompts before a customer hits a limit.',
        ].join(' '),
        responses: { 200: { description: 'Configuration snapshot.' } },
      },
    },
    '/plans': {
      get: {
        tags: ['System'],
        summary: 'Plan catalog',
        description: [
          'The four plans with their limits, features and prices. Public, so a pricing page can render before anyone signs up.',
          'Mooring is free and covers two active domains. Fairway is 19, Harbor is 79 and Admiralty is 249 per month.',
          'Data export and erasure are included on every plan, because the right to access and delete personal data cannot be paywalled.',
        ].join(' '),
        responses: { 200: { description: 'Plan catalog.' } },
      },
    },
    '/workspaces/{organizationId}/exports': {
      get: {
        tags: ['Billing'],
        summary: 'List export jobs',
        description: 'Newest first. Download tokens are never returned by this list, only at creation.',
        parameters: [orgParam, ...queryPagination],
        responses: { 200: { description: 'Recent export jobs.' }, ...standardErrors },
      },
      post: {
        tags: ['Billing'],
        summary: 'Request a data export',
        description: [
          'Returns a signed, expiring download link. Included on every plan, including the free one, because the right to take your own data away cannot be a paid feature.',
          'Scope the export to a single client to hand one customer only their own data, which is the usual agency request.',
          'Passwords, session tokens and OAuth tokens are never included. They are credentials, not data, and exporting them would hand over the ability to impersonate the account.',
          'Named forensic data is included when it exists, because it is the customer own data. Where nothing was stored, nothing is invented.',
          'Security records are included by action and time with identifying fields withheld, and the file says so.',
        ].join(' '),
        parameters: [orgParam],
        responses: {
          ...standardErrors,
          201: { description: 'Export job with a download link that expires in seven days.' },
          404: { description: 'The client or domain is not in this workspace.' },
        },
      },
    },
    '/workspaces/{organizationId}/exports/{exportId}': {
      get: {
        tags: ['Billing'],
        summary: 'Export job status',
        description: 'Current state of one export job, when its download link expires, and when the job record itself is purged.',
        parameters: [orgParam, idParam('exportId', 'Export job identifier.')],
        responses: { 200: { description: 'Job state, link expiry and purge date.' }, ...standardErrors },
      },
      delete: {
        tags: ['Billing'],
        summary: 'Revoke an export link',
        description: 'Stops the link working immediately. Recorded in the audit trail.',
        parameters: [orgParam, idParam('exportId', 'Export job identifier.')],
        responses: { 204: { description: 'Link revoked.' }, ...standardErrors },
      },
    },
    '/workspaces/{organizationId}/exports/{exportId}/download': {
      get: {
        tags: ['Billing'],
        summary: 'Download an export',
        description: [
          'Streams the export as a file. Requires both a valid session and the single use download token, and the token is stored only as a SHA-256 hash so a database read cannot recover it.',
          'JSON is complete and machine readable. CSV is a spreadsheet of report rows and forensic rows for analysis.',
        ].join(' '),
        parameters: [
          orgParam,
          idParam('exportId', 'Export job identifier.'),
          { name: 'token', in: 'query', required: true, schema: { type: 'string' } },
        ],
        responses: {
          ...standardErrors,
          200: { description: 'The export file.' },
          400: { description: 'No download token was supplied.' },
          404: { description: 'The link is invalid, expired or revoked.' },
        },
      },
    },
    '/workspaces/{organizationId}/entitlements': {
      get: {
        tags: ['Billing'],
        summary: 'What this workspace may do right now',
        description: [
          'The effective plan, its limits, and every feature flag after plan and any support override are applied.',
          'Internal override reasons are only returned to a member who can change billing.',
        ].join(' '),
        parameters: [orgParam],
        responses: { 200: { description: 'Resolved entitlements.' }, ...standardErrors },
      },
    },
    '/workspaces/{organizationId}/plan': {
      get: {
        tags: ['Billing'],
        summary: 'Current plan and catalog',
        description: 'Current plan plus the full catalog, for a billing page.',
        parameters: [orgParam],
        responses: { 200: { description: 'Current plan and catalog.' }, ...standardErrors },
      },
      patch: {
        tags: ['Billing'],
        summary: 'Change plan',
        description: [
          'Requires billing update, which only the workspace owner holds.',
          'Used by support and by the billing providers to move a workspace between plans. Every change is recorded in the audit trail.',
        ].join(' '),
        parameters: [orgParam],
        responses: { 200: { description: 'Updated entitlements.' }, ...standardErrors },
      },
    },
    '/workspaces/{organizationId}/entitlement-overrides': {
      post: {
        tags: ['Billing'],
        summary: 'Grant or revoke a single entitlement',
        description: [
          'Turns one feature on or off for this workspace without changing its plan, for a trial extension, a partner pilot or a goodwill fix.',
          'Always requires a reason and can carry an expiry so the override lapses on its own. Recorded in the audit trail.',
        ].join(' '),
        parameters: [orgParam],
        responses: { 200: { description: 'Updated entitlements.' }, ...standardErrors },
      },
    },
    '/workspaces/{organizationId}/entitlement-overrides/{entitlement}': {
      delete: {
        tags: ['Billing'],
        summary: 'Remove an override',
        description: 'Returns the workspace to whatever the plan alone grants. Recorded in the audit trail.',
        parameters: [orgParam, idParam('entitlement', 'Entitlement key, for example reports.forensicNamed.')],
        responses: { 200: { description: 'Updated entitlements.' }, ...standardErrors },
      },
    },
    '/docs/openapi.json': {
      get: {
        tags: ['System'],
        summary: 'This document',
        description: 'Returns the OpenAPI contract the frontend should be built against.',
        responses: { 200: { description: 'OpenAPI contract.' } },
      },
    },
    '/workspaces/{organizationId}/audit-events': {
      get: {
        tags: ['System'],
        summary: 'Audit trail',
        description: 'Append-only record of sensitive actions. Owner, admin or analyst.',
        parameters: [
          orgParam,
          ...queryPagination,
          { name: 'domainId', in: 'query', required: false, schema: { type: 'string' } },
          { name: 'action', in: 'query', required: false, schema: { type: 'string' } },
        ],
        responses: {
          200: { description: 'Audit events, newest first.' },
          ...standardErrors,
        },
      },
    },
    '/me/sessions': {
      get: {
        tags: ['Auth'],
        summary: 'List active sessions',
        description: [
          'One row per sign in, showing the device, address and age. The session token is never returned, because the token is the credential.',
          'Exactly one row has current set to true, which is the caller own session.',
        ].join(' '),
        responses: { 200: { description: 'Sessions, newest first.' }, ...standardErrors },
      },
    },
    '/me/sessions/{sessionId}': {
      delete: {
        tags: ['Auth'],
        summary: 'Revoke one session',
        description: 'Only the caller own sessions can be revoked. Revoking the current session returns 409, since that is sign out.',
        parameters: [idParam('sessionId', 'Session identifier from the list endpoint.')],
        responses: {
          ...standardErrors,
          204: { description: 'Revoked and recorded in the audit trail.' },
          404: { description: 'No such session belongs to the caller.' },
          409: { description: 'That is the session currently in use.' },
        },
      },
    },
    '/me/sessions/revoke-others': {
      post: {
        tags: ['Auth'],
        summary: 'Sign out every other device',
        description: [
          'Keeps the current session. This is the response to a suspected compromise.',
          'A password change also revokes other sessions automatically, because the API forces that on every password change.',
        ].join(' '),
        responses: { 200: { description: 'How many sessions remain.' }, ...standardErrors },
      },
    },
    '/me/sessions/revoke-all': {
      post: {
        tags: ['Auth'],
        summary: 'Sign out everywhere including this device',
        description: 'Ends every session for the account, so the caller is signed out too.',
        responses: { 204: { description: 'All sessions revoked.' }, ...standardErrors },
      },
    },
    '/me': {
      get: {
        tags: ['Auth'],
        summary: 'Current session and user',
        description: 'Returns the signed-in user, email verification state and active workspace id.',
        responses: { 200: { description: 'Session details.' }, ...standardErrors },
      },
    },
    '/workspaces': {
      get: {
        tags: ['Auth'],
        summary: 'List workspaces for the signed-in user',
        description: 'Used to populate the workspace switcher.',
        responses: { 200: { description: 'Workspaces the user belongs to.' }, ...standardErrors },
      },
      post: {
        tags: ['Auth'],
        summary: 'Create a workspace',
        description: 'Creates an agency workspace and makes the caller its owner.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name', 'slug'],
                properties: {
                  name: { type: 'string', minLength: 2, maxLength: 100 },
                  slug: { type: 'string', pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$' },
                },
              },
            },
          },
        },
        responses: { 201: { description: 'Workspace created.' }, ...standardErrors },
      },
    },
    '/workspaces/{organizationId}/members': {
      get: {
        tags: ['Auth'],
        summary: 'List workspace members',
        description: 'Returns each member with the role that drives their permissions.',
        parameters: [orgParam],
        responses: { 200: { description: 'Members and roles.' }, ...standardErrors },
      },
    },
    '/scan': {
      post: {
        tags: ['Scanning'],
        summary: 'Public single domain scan',
        description: 'Unauthenticated and rate limited. Returns a score and the issues found, without storing anything.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['domain'],
                properties: { domain: { type: 'string', minLength: 3, maxLength: 253 } },
              },
            },
          },
        },
        responses: { 200: { description: 'Scan result.' }, ...standardErrors },
      },
    },
    '/workspaces/{organizationId}/clients': {
      get: {
        tags: ['Clients and domains'],
        summary: 'List clients',
        description: 'Owner, admin, analyst or viewer. Returns every client in the workspace with its domain counts.',
        parameters: [orgParam],
        responses: { 200: { description: 'Clients.' }, ...standardErrors },
      },
      post: {
        tags: ['Clients and domains'],
        summary: 'Create a client',
        description: 'Owner, admin or analyst. A client is a customer record, not a login.',
        parameters: [orgParam],
        responses: { 201: { description: 'Client created.' }, ...standardErrors },
      },
    },
    '/workspaces/{organizationId}/clients/{clientId}/domains': {
      get: {
        tags: ['Clients and domains'],
        summary: 'List domains for a client',
        description: 'Owner, admin, analyst or viewer. Includes verification status and last scan summary.',
        parameters: [orgParam, idParam('clientId', 'Client identifier.')],
        responses: { 200: { description: 'Domains.' }, ...standardErrors },
      },
      post: {
        tags: ['Clients and domains'],
        summary: 'Add a domain',
        description: 'Creates the domain in PENDING state with a verification token to publish as a DNS TXT record.',
        parameters: [orgParam, idParam('clientId', 'Client identifier.')],
        responses: { 201: { description: 'Domain created.' }, ...standardErrors },
      },
    },
    '/workspaces/{organizationId}/domains/{domainId}/verify': {
      post: {
        tags: ['Clients and domains'],
        summary: 'Verify a domain via DNS TXT',
        description: 'Checks for the verification token at _dmarcharbor.<domain> and moves the domain to VERIFIED on success.',
        parameters: [orgParam, idParam('domainId', 'Domain identifier.')],
        responses: { 200: { description: 'Domain verified.' }, ...standardErrors },
      },
    },
    '/workspaces/{organizationId}/domains/{domainId}/scans': {
      post: {
        tags: ['Scanning'],
        summary: 'Run a scan',
        description: 'Requires a verified domain. Stores the result and updates the domain summary.',
        parameters: [orgParam, idParam('domainId', 'Domain identifier.')],
        responses: { 201: { description: 'Scan completed.' }, ...standardErrors },
      },
      get: {
        tags: ['Scanning'],
        summary: 'List scans for a domain',
        description: 'Newest first. Only owner, admin, analyst or viewer of this workspace.',
        parameters: [orgParam, idParam('domainId', 'Domain identifier.')],
        responses: { 200: { description: 'Scan history.' }, ...standardErrors },
      },
    },
    '/workspaces/{organizationId}/scans/{scanId}': {
      get: {
        tags: ['Scanning'],
        summary: 'Get one scan',
        description: 'Returns the full stored scan result including the score breakdown.',
        parameters: [orgParam, idParam('scanId', 'Scan identifier.')],
        responses: { 200: { description: 'Scan detail.' }, ...standardErrors },
      },
    },
    '/workspaces/{organizationId}/domains/{domainId}/reports': {
      get: {
        tags: ['Reports'],
        summary: 'List aggregate reports',
        description: 'Paginated. Reports expire after the configured retention window.',
        parameters: [orgParam, idParam('domainId', 'Domain identifier.'), ...queryPagination],
        responses: { 200: { description: 'Page of reports.' }, ...standardErrors },
      },
      post: {
        tags: ['Reports'],
        summary: 'Manually ingest an aggregate report',
        description: 'Owner or admin. Accepts raw RUA XML.',
        parameters: [orgParam, idParam('domainId', 'Domain identifier.')],
        responses: { 201: { description: 'Stored.' }, ...standardErrors },
      },
    },
    '/workspaces/{organizationId}/reports/{reportId}': {
      get: {
        tags: ['Reports'],
        summary: 'Get one aggregate report',
        description: 'Returns the report with its per source records and authentication results.',
        parameters: [orgParam, idParam('reportId', 'Report identifier.')],
        responses: { 200: { description: 'Report detail.' }, ...standardErrors },
      },
    },
    '/workspaces/{organizationId}/domains/{domainId}/forensics': {
      get: {
        tags: ['Forensics'],
        summary: 'List forensic reports',
        description: 'Requires the forensic read permission, which viewer does not have. Recipients are pseudonymous unless the caller also holds forensic identify, in which case piiWithheld is false.',
        parameters: [orgParam, idParam('domainId', 'Domain identifier.'), ...queryPagination],
        responses: { 200: { description: 'Page of forensic reports.' }, ...standardErrors },
      },
      post: {
        tags: ['Forensics'],
        summary: 'Manually ingest a forensic report',
        description: 'Requires forensic ingest. The body is a raw RUF email rather than JSON, because the format is MIME multipart.',
        parameters: [orgParam, idParam('domainId', 'Domain identifier.')],
        responses: { 201: { description: 'Stored.' }, ...standardErrors },
      },
      patch: {
        tags: ['Forensics'],
        summary: 'Enable or disable forensic collection',
        description: 'Requires forensic ingest. Off by default. Also requires the domain to publish a ruf= address before reports are accepted.',
        parameters: [orgParam, idParam('domainId', 'Domain identifier.')],
        responses: { 200: { description: 'Updated.' }, ...standardErrors },
      },
      delete: {
        tags: ['Forensics'],
        summary: 'Purge every forensic record for a domain',
        description: 'Requires forensic purge. Recorded in the audit trail.',
        parameters: [orgParam, idParam('domainId', 'Domain identifier.')],
        responses: { 200: { description: 'Deleted count.' }, ...standardErrors },
      },
    },
    '/workspaces/{organizationId}/domains/{domainId}/forensics/identities': {
      patch: {
        tags: ['Forensics'],
        summary: 'Enable or disable storage of named recipients',
        description: [
          'Requires forensic identify, which only owner and admin hold.',
          'Enabling requires confirmLegalBasis because recipient addresses are personal data.',
          'Disabling requires confirmNamePurge and permanently deletes stored names while keeping pseudonymous evidence.',
        ].join(' '),
        parameters: [orgParam, idParam('domainId', 'Domain identifier.')],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['retainForensicPii'],
                properties: {
                  retainForensicPii: { type: 'boolean' },
                  confirmLegalBasis: { type: 'boolean', description: 'Required when enabling.' },
                  confirmNamePurge: { type: 'boolean', description: 'Required when disabling.' },
                },
              },
            },
          },
        },
        responses: {
          ...standardErrors,
          200: { description: 'Updated. Includes purgedIdentities when names were destroyed.' },
          400: errorResponse('Missing confirmation flag. The response names which one is required.'),
        },
      },
    },
    '/workspaces/{organizationId}/forensics/{forensicId}': {
      get: {
        tags: ['Forensics'],
        summary: 'Get one forensic report',
        description: 'Named fields are only returned to callers holding the forensic identify permission. Others receive piiWithheld instead.',
        parameters: [orgParam, idParam('forensicId', 'Forensic report identifier.')],
        responses: { 200: { description: 'Detail.' }, ...standardErrors },
      },
      delete: {
        tags: ['Forensics'],
        summary: 'Delete one forensic report',
        description: 'Requires forensic purge. Recorded in the audit trail.',
        parameters: [orgParam, idParam('forensicId', 'Forensic report identifier.')],
        responses: { 204: { description: 'Deleted.' }, ...standardErrors },
      },
    },
    '/workspaces/{organizationId}/alert-rules': {
      get: {
        tags: ['Alerts'],
        summary: 'List alert rules',
        description: 'Newest first. Each rule lists its recipients, which are the people who receive its notifications.',
        parameters: [orgParam, ...queryPagination],
        responses: { 200: { description: 'Page of rules.' }, ...standardErrors },
      },
      post: {
        tags: ['Alerts'],
        summary: 'Create an alert rule',
        description: [
          'Requires report update. Recorded in the audit trail.',
          'Metrics are FAILURE_COUNT, FAILURE_RATE, SOURCE_IP_VOLUME, FORENSIC_FAILURES, REPORT_SILENCE and NEW_UNAUTHENTICATED_SOURCE.',
          'NEW_UNAUTHENTICATED_SOURCE counts sending sources first seen in the last seven days that failed both SPF and DKIM, which is the closest signal to a spoofing attempt. Use GREATER_THAN_OR_EQUAL with a threshold of 1.',
        ].join(' '),
        parameters: [orgParam],
        responses: { 201: { description: 'Rule created.' }, ...standardErrors },
      },
    },
    '/workspaces/{organizationId}/alert-rules/{ruleId}': {
      patch: {
        tags: ['Alerts'],
        summary: 'Update an alert rule',
        description: 'Can change threshold, window, cooldown, recipients or enablement. Recorded in the audit trail.',
        parameters: [orgParam, idParam('ruleId', 'Rule identifier.')],
        responses: { 200: { description: 'Updated.' }, ...standardErrors },
      },
      delete: {
        tags: ['Alerts'],
        summary: 'Delete an alert rule',
        description: 'Removes the rule and its recipients. Already fired alerts are kept. Recorded in the audit trail.',
        parameters: [orgParam, idParam('ruleId', 'Rule identifier.')],
        responses: { 204: { description: 'Deleted.' }, ...standardErrors },
      },
    },
    '/workspaces/{organizationId}/alerts': {
      get: {
        tags: ['Alerts'],
        summary: 'List alert events',
        description: 'Each event carries a status of OPEN, ACKNOWLEDGED, RESOLVED or STALE.',
        parameters: [
          orgParam,
          ...queryPagination,
          { name: 'domainId', in: 'query', required: false, schema: { type: 'string' } },
        ],
        responses: { 200: { description: 'Page of alert events.' }, ...standardErrors },
      },
    },
    '/workspaces/{organizationId}/alerts/{eventId}/acknowledge': {
      post: {
        tags: ['Alerts'],
        summary: 'Acknowledge an alert',
        description: 'Stops further reminders. Suppresses re-triggering for one window only.',
        parameters: [orgParam, idParam('eventId', 'Alert event identifier.')],
        responses: {
          ...standardErrors,
          200: { description: 'Acknowledged.' },
          409: errorResponse('Already acknowledged or resolved.'),
        },
      },
    },
    '/me/notifications': {
      get: {
        tags: ['Notifications'],
        summary: 'List in-app notifications',
        description: 'Created for alert recipients regardless of email preferences. Newest first, and scoped to the signed-in user.',
        parameters: [
          ...queryPagination,
          {
            name: 'unreadOnly',
            in: 'query',
            required: false,
            schema: { type: 'boolean' },
          },
        ],
        responses: { 200: { description: 'Notifications plus an unread count.' }, ...standardErrors },
      },
    },
    '/me/notifications/unread-count': {
      get: {
        tags: ['Notifications'],
        summary: 'Unread notification count',
        description: 'Single number intended for a navigation badge.',
        responses: { 200: { description: 'Count for a badge.' }, ...standardErrors },
      },
    },
    '/me/notifications/{notificationId}/read': {
      post: {
        tags: ['Notifications'],
        summary: 'Mark one notification read',
        description: 'Marking twice returns 409 rather than silently succeeding.',
        parameters: [idParam('notificationId', 'Notification identifier.')],
        responses: { 200: { description: 'Marked read.' }, ...standardErrors },
      },
    },
    '/me/notifications/read-all': {
      post: {
        tags: ['Notifications'],
        summary: 'Mark all notifications read',
        description: 'Returns how many notifications were marked.',
        responses: { 200: { description: 'Count marked.' }, ...standardErrors },
      },
    },
    '/me/{userId}/notification-preferences': {
      get: {
        tags: ['Notifications'],
        summary: 'Get notification preferences',
        description: 'Callers may only read their own preferences. Defaults to email alerts on, no quiet hours, and the UTC timezone.',
        parameters: [idParam('userId', 'Must be the signed-in user.')],
        responses: { 200: { description: 'Preferences.' }, ...standardErrors },
      },
      patch: {
        tags: ['Notifications'],
        summary: 'Update notification preferences',
        description: 'Quiet hours are evaluated in the supplied IANA timezone. Send both quiet hour fields or neither.',
        parameters: [idParam('userId', 'Must be the signed-in user.')],
        responses: { 200: { description: 'Updated.' }, ...standardErrors },
      },
    },
    '/workspaces/{organizationId}/onboarding': {
      get: {
        tags: ['Onboarding and sharing'],
        summary: 'Portfolio onboarding overview',
        description: 'Aggregates every domain in the workspace with five database queries regardless of domain count.',
        parameters: [orgParam],
        responses: { 200: { description: 'Totals plus per client and per domain state.' }, ...standardErrors },
      },
    },
    '/workspaces/{organizationId}/domains/{domainId}/onboarding': {
      get: {
        tags: ['Onboarding and sharing'],
        summary: 'Onboarding state for one domain',
        description: 'Returns per step status plus the policy readiness result.',
        parameters: [orgParam, idParam('domainId', 'Domain identifier.')],
        responses: { 200: { description: 'Onboarding state.' }, ...standardErrors },
      },
    },
    '/workspaces/{organizationId}/domains/{domainId}/dmarc-record': {
      get: {
        tags: ['Onboarding and sharing'],
        summary: 'Generate the DMARC TXT record',
        description: [
          'Returns the exact record value for the requested policy.',
          'Use pct to apply the policy to only part of your mail, so a misconfigured sending service cannot block everything at once.',
          'The usual ladder is 5, 10, 25, 50, then 100. pct is left out when it is 100, and has no effect while p=none.',
        ].join(' '),
        parameters: [
          orgParam,
          idParam('domainId', 'Domain identifier.'),
          {
            name: 'policy',
            in: 'query',
            required: false,
            schema: { type: 'string', enum: ['none', 'quarantine', 'reject'], default: 'none' },
          },
          {
            name: 'pct',
            in: 'query',
            required: false,
            description: 'Share of mail the policy applies to, as a whole number from 0 to 100.',
            schema: { type: 'integer', minimum: 0, maximum: 100, default: 100 },
          },
          {
            name: 'forensics',
            in: 'query',
            required: false,
            schema: { type: 'boolean', default: false },
          },
        ],
        responses: { 200: { description: 'Record host, value, pct and setup notes.' }, ...standardErrors },
      },
    },
    '/workspaces/{organizationId}/domains/{domainId}/senders': {
      get: {
        tags: ['Reports'],
        summary: 'Per sending service breakdown',
        description: [
          'Splits traffic by sending service, which is the source IP combined with the aligned authentication domain.',
          'A blended pass rate hides a rare but broken sender inside a large healthy one, so each sender is graded on its own failure share.',
          'Grades are clean, degraded, failing, or insufficient-data when there are too few messages to judge.',
          'Senders first seen within the last seven days are flagged as new, which is how a spoofed source or an unexpected new service shows up.',
          'A new sender is graded authenticated when it passes both SPF and DKIM, partially-authenticated when it passes only one, and unauthenticated when it passes neither.',
          'possibleSpoofingSources lists new senders that pass neither, because a legitimate service normally passes at least one.',
        ].join(' '),
        parameters: [orgParam, idParam('domainId', 'Domain identifier.')],
        responses: { 200: { description: 'Sender rows, new sender findings, and the thresholds used to grade them.' }, ...standardErrors },
      },
    },
    '/workspaces/{organizationId}/domains/{domainId}/policy-readiness': {
      get: {
        tags: ['Onboarding and sharing'],
        summary: 'Policy readiness and blockers',
        description: [
          'Never changes anything. Reports whether tightening is safe and lists every blocker.',
          'Two gates exist to protect legitimate mail that a blended pass rate would hide: a per sending service failure gate, and a staged rollout gate that forbids jumping straight to reject.',
        ].join(' '),
        parameters: [orgParam, idParam('domainId', 'Domain identifier.')],
        responses: { 200: { description: 'Readiness plus human readable blockers.' }, ...standardErrors },
      },
    },
    '/workspaces/{organizationId}/domains/{domainId}/insights': {
      get: {
        tags: ['Reports'],
        summary: 'Domain insights',
        description: 'Summary, source attribution, daily trends and spike detection across both report types.',
        parameters: [
          orgParam,
          idParam('domainId', 'Domain identifier.'),
          {
            name: 'days',
            in: 'query',
            required: false,
            schema: { type: 'integer', minimum: 1, maximum: 365 },
          },
        ],
        responses: { 200: { description: 'Insights payload.' }, ...standardErrors },
      },
    },
    '/workspaces/{organizationId}/report-shares': {
      get: {
        tags: ['Onboarding and sharing'],
        summary: 'List share links',
        description: 'Includes view count and last viewed time so an agency can tell whether a client opened the link.',
        parameters: [orgParam, ...queryPagination],
        responses: { 200: { description: 'Page of share links.' }, ...standardErrors },
      },
      post: {
        tags: ['Onboarding and sharing'],
        summary: 'Create a share link',
        description: 'Requires report update. The public response never contains personal data or pseudonyms.',
        parameters: [orgParam],
        responses: { 201: { description: 'Share created, with the public url.' }, ...standardErrors },
      },
    },
    '/workspaces/{organizationId}/report-shares/{shareId}': {
      delete: {
        tags: ['Onboarding and sharing'],
        summary: 'Revoke a share link',
        description: 'Recorded in the audit trail.',
        parameters: [orgParam, idParam('shareId', 'Share identifier.')],
        responses: { 204: { description: 'Revoked.' }, ...standardErrors },
      },
    },
    '/reports/share/{token}': {
      get: {
        tags: ['Onboarding and sharing'],
        summary: 'Public client report',
        description: [
          'The only unauthenticated read endpoint. Rate limited to 30 requests per minute.',
          'Never returns recipient pseudonyms, subject lines, addresses or alert history.',
        ].join(' '),
        parameters: [idParam('token', 'Share token from the created share link.')],
        responses: {
          200: { description: 'Client facing report.' },
          404: errorResponse('Unknown, revoked or expired token.'),
          429: errorResponse('Rate limit exceeded.'),
        },
      },
    },
    '/workspaces/{organizationId}/report-digests': {
      get: {
        tags: ['Notifications'],
        summary: 'List scheduled digests',
        description: 'Newest first. Recipients are stored as plain email addresses and never exposed in digests.',
        parameters: [orgParam, ...queryPagination],
        responses: { 200: { description: 'Page of digests.' }, ...standardErrors },
      },
      post: {
        tags: ['Notifications'],
        summary: 'Schedule a client digest',
        description: 'Requires report update. Never includes personal data.',
        parameters: [orgParam],
        responses: { 201: { description: 'Digest created.' }, ...standardErrors },
      },
    },
    '/workspaces/{organizationId}/report-digests/{digestId}': {
      patch: {
        tags: ['Notifications'],
        summary: 'Update a digest',
        description: 'Recorded in the audit trail. Day of month is capped at 28 so a schedule never silently skips a month.',
        parameters: [orgParam, idParam('digestId', 'Digest identifier.')],
        responses: { 200: { description: 'Updated.' }, ...standardErrors },
      },
      delete: {
        tags: ['Notifications'],
        summary: 'Delete a digest',
        description: 'Removes the schedule. Recorded in the audit trail.',
        parameters: [orgParam, idParam('digestId', 'Digest identifier.')],
        responses: { 204: { description: 'Deleted.' }, ...standardErrors },
      },
    },
    '/workspaces/{organizationId}/report-digests/{digestId}/send': {
      post: {
        tags: ['Notifications'],
        summary: 'Send a digest immediately',
        description: 'Returns a preview so the caller can verify content before scheduling.',
        parameters: [orgParam, idParam('digestId', 'Digest identifier.')],
        responses: { 200: { description: 'Sent, with subject and preview text.' }, ...standardErrors },
      },
    },
    '/workspaces/{organizationId}/report-digests/run': {
      post: {
        tags: ['Notifications'],
        summary: 'Run due digests now',
        description: 'Normally called by the scheduler.',
        parameters: [orgParam],
        responses: { 200: { description: 'How many were processed and sent.' }, ...standardErrors },
      },
    },
    '/internal/reports/inbound': {
      post: {
        tags: ['System'],
        summary: 'Receive a report email',
        description: [
          'Machine to machine. Requires a valid HMAC signature and a timestamp within 300 seconds.',
          'Accepts aggregate and forensic MIME messages and routes them automatically.',
        ].join(' '),
        requestBody: {
          required: true,
          content: {
            'message/rfc822': { schema: { type: 'string', description: 'Raw email bytes.' } },
          },
        },
        responses: {
          ...standardErrors,
          200: { description: 'Per report outcome, with status created, duplicate or rejected.' },
          401: errorResponse('Invalid signature or stale timestamp.'),
        },
      },
    },
  },
  security: [{ sessionCookie: [] }],
  components: {
    securitySchemes: {
      sessionCookie: {
        type: 'apiKey',
        in: 'cookie',
        name: 'better-auth.session_token',
        description: 'Session cookie set by Better Auth after sign in.',
      },
    },
    schemas: {
      ApiError: {
        type: 'object',
        required: ['error'],
        properties: {
          error: {
            type: 'object',
            required: ['code', 'message'],
            properties: {
              code: {
                type: 'string',
                enum: [
                  'INVALID_REQUEST',
                  'UNAUTHORIZED',
                  'FORBIDDEN',
                  'NOT_FOUND',
                  'CONFLICT',
                  'RATE_LIMITED',
                  'INTERNAL',
                ],
              },
              message: { type: 'string' },
              requiresNamePurgeConfirmation: {
                type: 'boolean',
                description: 'Present only on a 400 from the identity toggle, telling the UI to show a confirmation dialog.',
              },
            },
          },
        },
      },
      Page: paginated({ type: 'object' }),
    },
  },
} as const;
