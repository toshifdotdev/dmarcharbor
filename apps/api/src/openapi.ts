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

const connectionParam = idParam('connectionId', 'The identity provider connection to use.');

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
    { name: 'Webhooks' },
    { name: 'Client portal' },
    { name: 'White label' },
  ],
  paths: {
    '/v1/clients': {
      get: {
        tags: ['API'],
        summary: 'List clients with their domains',
        description: [
          'Machine readable counterpart to the browser interface, for a professional service automation tool or an internal script.',
          'The workspace is taken from the API key rather than the path, so a key can never be pointed at another workspace by mistake.',
          'Paged: returns at most 50 rows by default and at most 200, with `nextCursor` present when a further page exists.',
          'Pass the cursor back as `?cursor=` to continue. A limit outside 1 to 200 is refused rather than clamped.',
        ].join(' '),
        security: [{ apiKeyAuth: [] }],
        responses: { 200: { description: 'A page of clients, and the cursor for the next one.' } },
      },
      post: {
        tags: ['API'],
        summary: 'Create a client',
        description: 'Returns the domain verification records, ready to publish in the client own DNS.',
        security: [{ apiKeyAuth: [] }],
        responses: { 201: { description: 'Created, with verification details.' } },
      },
    },
    '/v1/clients/bulk': {
      post: {
        tags: ['API'],
        summary: 'Import many clients at once',
        description: [
          'The bulk counterpart to repeated single creates. Agencies usually have a client list before they have a domain list, so this accepts both together or clients alone.',
          'Every row is independent. A bad row is reported in failures and skipped rather than failing the batch, because a spreadsheet imported from a client CRM should not lose 180 valid rows to one typo.',
          'Rows beyond the plan limit are reported in planLimitRejections with the reason, and the rest still import.',
          'Send an Idempotency-Key header. A retried request replays the original response instead of creating duplicates, which matters because automation retries on timeout.',
        ].join(' '),
        security: [{ apiKeyAuth: [] }],
        responses: {
          201: { description: 'Per item results for created, failed and plan blocked rows.' },
          402: { description: 'The plan allows no further clients.' },
        },
      },
    },
    '/v1/domains': {
      get: {
        tags: ['API'],
        summary: 'List domains in the workspace',
        description: [
          'Flat list across all clients, each with its client, verification state and published policy.',
          'Paged: returns at most 50 rows by default and at most 200, with `nextCursor` present when a further page exists.',
          'An integration that wants everything walks the pages with `?cursor=`, which is the same thing the browser interface does for its own reports.',
        ].join(' '),
        security: [{ apiKeyAuth: [] }],
        responses: { 200: { description: 'A page of domains, and the cursor for the next one.' } },
      },
      post: {
        tags: ['API'],
        summary: 'Add one domain to a client',
        description: 'Returns the TXT record to publish so the domain can be verified without a second call.',
        security: [{ apiKeyAuth: [] }],
        responses: { 201: { description: 'Added, with the verification record to publish.' } },
      },
    },
    '/v1/domains/bulk': {
      post: {
        tags: ['API'],
        summary: 'Add many domains to one client',
        description: [
          'Deliberately separate from the client import, because agencies receive the domain list at a different time from the client list.',
          'Same guarantees as the client import: per row outcomes, plan limits reported rather than silently truncating, and Idempotency-Key support.',
        ].join(' '),
        security: [{ apiKeyAuth: [] }],
        responses: { 201: { description: 'Per item results.' } },
      },
    },
    '/v1/domains/{domainId}/verify': {
      post: {
        tags: ['API'],
        summary: 'Check domain ownership now',
        description: [
          'Reads the domain DNS TXT record and compares it to the expected value in constant time.',
          'Returns the host and value to publish so a caller can retry without a second read, and reports whether the record is found, still propagating or wrong.',
        ].join(' '),
        security: [{ apiKeyAuth: [] }],
        parameters: [idParam('domainId', 'Domain identifier from the domains list.')],
        responses: { 200: { description: 'Verification result and the record that is expected.' } },
      },
    },
    '/workspaces/{organizationId}/api-keys': {
      get: {
        tags: ['API'],
        summary: 'List API keys',
        description: 'Metadata only. The key itself is never retrievable after creation. Owner or admin. The public API is included from Harbor (api.access).',
        parameters: [orgParam],
        responses: { 200: { description: 'Keys with prefix, scopes, last used and expiry.' }, ...standardErrors },
      },
      post: {
        tags: ['API'],
        summary: 'Create an API key',
        description: [
          'Returns the full key exactly once. Only a hash is stored, so a database read cannot recover a usable key.',
          'Scopes are read, write, or both. A read scoped key cannot create or modify anything, which is the right choice for a dashboard or reporting integration.',
          'Owner only, because a key acts on the whole workspace with the authority of its scopes.',
          'Requires the api.access entitlement, which starts at Harbor; below it the answer is 402. A key issued before a downgrade stops authenticating until the plan carries the API again.',
        ].join(' '),
        parameters: [orgParam],
        responses: { 201: { description: 'The key, shown once.' }, ...standardErrors },
      },
    },
    '/workspaces/{organizationId}/api-keys/{keyId}': {
      delete: {
        tags: ['API'],
        summary: 'Revoke an API key',
        description: 'Takes effect immediately. Recorded in the audit trail.',
        parameters: [orgParam, idParam('keyId', 'Key identifier.')],
        responses: { 204: { description: 'Revoked.' }, ...standardErrors },
      },
    },
    '/workspaces/{organizationId}/deletion-preview': {
      get: {
        tags: ['Lifecycle'],
        summary: 'What deleting this workspace would destroy',
        description: [
          'Counts every row a workspace deletion removes, without deleting anything: domains, reports, forensic reports, alert rules and events, scans, share links, portal grants and compliance packs.',
          'A confirmation screen shows these numbers so the operator sees the scale of what they are about to do. A preview that cannot be read is a confirmation that asks the operator to trust a guess.',
        ].join(' '),
        parameters: [orgParam],
        responses: { 200: { description: 'The counts a workspace deletion would remove.' }, ...standardErrors },
      },
    },
    '/workspaces/{organizationId}/domains/{domainId}': {
      delete: {
        tags: ['Lifecycle'],
        summary: 'Delete a domain and its evidence',
        description: [
          'Removes the domain together with every DMARC report, forensic report, alert rule, alert event, scan, share link and digest attached to it. This destroys evidence a customer paid to produce and cannot be undone.',
          'Takes the slug as well as the id, because a URL carries the slug.',
          'A domain belonging to another workspace is answered as not found rather than as a permission refusal, which would confirm the domain exists somewhere.',
        ].join(' '),
        parameters: [orgParam, idParam('domainId', 'Domain identifier, id or slug.')],
        responses: {
          200: {
            description: 'Deleted. The response carries what was destroyed, so the confirmation and the result cannot disagree.',
          },
          ...standardErrors,
        },
      },
    },
    '/workspaces/{organizationId}/clients/{clientId}': {
      delete: {
        tags: ['Lifecycle'],
        summary: 'Delete a client and everything under it',
        description: [
          'Removes the client, its domains and everything under them, plus its compliance packs and share links.',
          'Refused while a portal access grant still exists for the client, with PORTAL_ACCESS_STILL_GRANTED: the contact is holding a working Trust Center link, and deleting underneath it would leave them with a dead one. Revoke the grant first.',
        ].join(' '),
        parameters: [orgParam, idParam('clientId', 'Client identifier.')],
        responses: {
          200: { description: 'Deleted, with what went alongside it.' },
          ...standardErrors,
        },
      },
    },
    '/workspaces/{organizationId}': {
      delete: {
        tags: ['Lifecycle'],
        summary: 'Delete a whole workspace',
        description: [
          'Removes the workspace and every row in it. There is no undo.',
          'Refused while a subscription is active, with SUBSCRIPTION_STILL_ACTIVE: cancelling is a billing action with a period end and a refund policy, and deleting the workspace is not a way to cancel. It would strand a paid period the customer has already been charged for, with no order left to refund against.',
          'The confirmation that names the workspace is the UI job; this route is guarded by the owner permission instead. A browser action that cannot be undone is guarded twice on purpose, and neither guard substitutes for the other.',
        ].join(' '),
        parameters: [orgParam],
        responses: {
          200: { description: 'Deleted, with what went alongside it.' },
          ...standardErrors,
        },
      },
    },
    '/workspaces/{organizationId}/webhooks': {
      get: {
        tags: ['Webhooks'],
        summary: 'List webhook endpoints',
        description: [
          'Endpoints this workspace delivers events to. Subscribing events and delivery health, never the signing secret, which is shown once at creation.',
          'A large agency receives hundreds of report notifications a day, so domain.verified and alert.triggered are subscribed by default and report.received, dns.changed, policy.changed and forensic.received are opt in. Ignoring events trains people to ignore the endpoint.',
          'Webhooks are included from Fairway. A workspace that downgrades keeps its endpoints and can still list, pause and delete them; delivery resumes on upgrade.',
        ].join(' '),
        parameters: [orgParam],
        responses: { 200: { description: 'Endpoints with their events and delivery health.' }, ...standardErrors },
      },
      post: {
        tags: ['Webhooks'],
        summary: 'Register a webhook endpoint',
        description: [
          'Returns a signing secret once. We sign every payload with HMAC SHA-256 over the timestamp and the body, and the receiver recomputes it to confirm the event really came from DMARC Harbor.',
          'The URL must be public https. A local or private address is refused, because a customer cannot receive a delivery from inside our network.',
          'Included from Fairway. A plan without it answers 402 with feature integrations.webhooks.',
        ].join(' '),
        parameters: [orgParam],
        responses: {
          201: { description: 'Endpoint created, with the signing secret shown once.' },
          402: { description: 'Webhooks are not included in this workspace plan.' },
          ...standardErrors,
        },
      },
    },
    '/workspaces/{organizationId}/webhooks/{webhookId}': {
      patch: {
        tags: ['Webhooks'],
        summary: 'Update an endpoint',
        description: [
          'Change the url, subscribed events, or pause and resume delivery.',
          'Setting only active:false is always allowed, so a downgraded workspace can stop delivery. Any other change needs the Fairway webhook entitlement and answers 402 without it.',
        ].join(' '),
        parameters: [orgParam, idParam('webhookId', 'Endpoint identifier.')],
        responses: {
          200: { description: 'Updated.' },
          402: { description: 'The requested change needs webhooks, which this plan does not include.' },
          ...standardErrors,
        },
      },
      delete: {
        tags: ['Webhooks'],
        summary: 'Delete an endpoint',
        description: 'Stops delivery immediately and removes the delivery history with it. Never plan-gated, so a downgraded workspace can always remove what it configured.',
        parameters: [orgParam, idParam('webhookId', 'Endpoint identifier.')],
        responses: { 204: { description: 'Deleted along with its delivery history.' }, ...standardErrors },
      },
    },
    '/workspaces/{organizationId}/webhooks/test': {
      post: {
        tags: ['Webhooks'],
        summary: 'Queue a test delivery',
        description: 'Queues one event so the receiver can confirm its endpoint and signature handling. Safe to call at any time. Included from Fairway.',
        parameters: [orgParam],
        responses: {
          202: { description: 'Queued, or reported as having no subscriber.' },
          402: { description: 'Webhooks are not included in this workspace plan.' },
          ...standardErrors,
        },
      },
    },
    '/workspaces/{organizationId}/webhook-deliveries': {
      get: {
        tags: ['Webhooks'],
        summary: 'Delivery log',
        description: [
          'Every attempt, with the response code and the last error, so a failing integration can be diagnosed without waiting for the customer to report it.',
          'A payload is a pointer, not the data. When a report arrives the event carries identifiers and a timestamp, and the integration fetches detail from the read API if it wants it. Embedding report contents would make a high volume feed slow and would duplicate the API.',
          'Readable on every plan, including after a downgrade, so the history remains diagnosable.',
        ].join(' '),
        parameters: [orgParam, { name: 'endpointId', in: 'query', required: false, schema: { type: 'string' } }],
        responses: { 200: { description: 'Recent deliveries.' }, ...standardErrors },
      },
    },
    '/workspaces/{organizationId}/webhook-deliveries/{deliveryId}/replay': {
      post: {
        tags: ['Webhooks'],
        summary: 'Replay a delivery',
        description: 'Requeues a failed delivery with the same payload and a fresh signature. Useful after the receiver has been fixed. Included from Fairway.',
        parameters: [orgParam, idParam('deliveryId', 'Delivery identifier.')],
        responses: {
          202: { description: 'Requeued.' },
          402: { description: 'Webhooks are not included in this workspace plan.' },
          ...standardErrors,
        },
      },
    },
    '/workspaces/{organizationId}/clients/{clientId}/portal-access': {
      post: {
        tags: ['Client portal'],
        summary: 'Invite a client contact to see their own report',
        description: [
          'The grant is held against an email address, not an account, so the agency never sets a password on behalf of somebody else staff. It activates the first time that person signs in with the same address, and works equally with a password or with Google or Microsoft sign in.',
          'A grant covers exactly one client. The contact cannot see any other client in the workspace, whichever internal role they also happen to hold.',
          'Requires the portal.client entitlement, so it is a Harbor and Admiralty feature.',
        ].join(' '),
        parameters: [orgParam, idParam('clientId', 'Client the contact should see.')],
        responses: {
          ...standardErrors,
          201: { description: 'Grant created, with bound set to false until they first sign in.' },
          402: { description: 'The plan does not include the client portal.' },
          404: { description: 'Client not found in this workspace.' },
        },
      },
    },
    '/workspaces/{organizationId}/portal-access': {
      get: {
        tags: ['Client portal'],
        summary: 'List client portal grants',
        description: 'Shows every invited contact, whether they have signed in yet, and when they were last seen. Agency staff only.',
        parameters: [orgParam, { name: 'clientId', in: 'query', required: false, schema: { type: 'string' } }],
        responses: { 200: { description: 'Grants with their binding state.' }, ...standardErrors },
      },
    },
    '/workspaces/{organizationId}/portal-access/revoked': {
      delete: {
        tags: ['Client portal'],
        summary: 'Remove every revoked grant',
        description: [
          'Deletes the rows of every revoked grant in the workspace, releasing the contact email addresses they held.',
          'Active grants are untouched: someone still has access through one.',
          'Reports how many were actually removed, so a caller never has to infer "cleaned up" from a silent success.',
        ].join(' '),
        parameters: [orgParam],
        responses: { 200: { description: 'Removed, with the count.' }, ...standardErrors },
      },
    },
    '/workspaces/{organizationId}/portal-access/{accessId}/permanent': {
      delete: {
        tags: ['Client portal'],
        summary: 'Remove a revoked grant permanently',
        description: [
          'Deletes one revoked grant row, so the contact address is no longer held.',
          'Refused with 409 while the grant is still active: revoking is what leaves the record that access was ended, and removing a live contact quietly would erase that record.',
        ].join(' '),
        parameters: [orgParam, idParam('accessId', 'Grant identifier.')],
        responses: { 204: { description: 'Removed.' }, ...standardErrors },
      },
    },
    '/workspaces/{organizationId}/portal-access/{accessId}': {
      delete: {
        tags: ['Client portal'],
        summary: 'Revoke a client contact',
        description: 'Takes effect on the next request. Recorded in the audit trail.',
        parameters: [orgParam, idParam('accessId', 'Grant identifier.')],
        responses: { 204: { description: 'Revoked.' }, ...standardErrors },
      },
    },
    '/workspaces/{organizationId}/report-shares/revoked': {
      delete: {
        tags: ['Report sharing'],
        summary: 'Remove every revoked share link',
        description: [
          'Deletes the rows of every revoked share link in the workspace.',
          'Live links are untouched: somebody is still reading through one.',
          'Reports how many were actually removed.',
        ].join(' '),
        parameters: [orgParam],
        responses: { 200: { description: 'Removed, with the count.' }, ...standardErrors },
      },
    },
    '/workspaces/{organizationId}/report-shares/{shareId}/permanent': {
      delete: {
        tags: ['Report sharing'],
        summary: 'Remove a revoked share link permanently',
        description: [
          'Deletes one revoked share link row, so a dead token stops appearing in the list an operator reads.',
          'Refused with 409 while the link is still live: revoking is what records that the link was pulled.',
          'The revocation itself remains in the audit trail.',
        ].join(' '),
        parameters: [orgParam, idParam('shareId', 'Share link identifier.')],
        responses: { 204: { description: 'Removed.' }, ...standardErrors },
      },
    },
    '/workspaces/{organizationId}/api-keys/revoked': {
      delete: {
        tags: ['API keys'],
        summary: 'Remove every revoked API key',
        description: [
          'Deletes the rows of every revoked key in the workspace.',
          'Live keys are untouched: an integration may still be using one.',
          'Reports how many were actually removed.',
        ].join(' '),
        parameters: [orgParam],
        responses: { 200: { description: 'Removed, with the count.' }, ...standardErrors },
      },
    },
    '/workspaces/{organizationId}/api-keys/{keyId}/permanent': {
      delete: {
        tags: ['API keys'],
        summary: 'Remove a revoked API key permanently',
        description: [
          'Deletes one revoked key row. Its name becomes reusable either way, so this is tidiness, not a block.',
          'Refused with 409 while the key is still live, so a working integration cannot be ended without the revocation being recorded.',
        ].join(' '),
        parameters: [orgParam, idParam('keyId', 'Key identifier.')],
        responses: { 204: { description: 'Removed.' }, ...standardErrors },
      },
    },
    '/portal': {
      get: {
        tags: ['Client portal'],
        summary: 'What a client contact can see',
        description: [
          'The whole portal surface for the signed in contact: their clients, their verified domains, their scores and published policy, and when the last report arrived.',
          'Scoped by the resolved grant list rather than by anything in the request, so a contact cannot widen their own view. An account with no grant is refused with a message explaining that they need an invitation.',
          'A contact invited by more than one workspace is answered 400 CHOOSE_WORKSPACE with the choices until organizationId is passed.',
          'The plan is checked on every portal read: when the workspace plan no longer includes the client portal, every portal route answers 403 PORTAL_PAUSED with workspaceName. The grants are kept, so an upgrade restores access with nothing to set up.',
          'Contains no forensic evidence, no recipient data, no billing and no other workspace content.',
        ].join(' '),
        responses: { 200: { description: 'The contact own clients and domains.' }, ...standardErrors },
      },
    },
    '/portal/domains/{domainId}': {
      get: {
        tags: ['Client portal'],
        summary: 'One domain report for a client contact',
        description: [
          'Aggregate results, the per sending service breakdown and any possible spoofing source, for a single domain.',
          'Forensic reports are deliberately absent. A client contact can see that mail failed and which service caused it, never who received it.',
        ].join(' '),
        parameters: [idParam('domainId', 'Domain identifier.')],
        responses: { 200: { description: 'Domain insights, senders and spoofing warnings.' }, ...standardErrors },
      },
    },
    '/workspaces/{organizationId}/branding': {
      get: {
        tags: ['White label'],
        summary: 'Stored white label settings',
        description: 'The raw branding values held for this workspace, including the custom domain and whether its DNS record has been verified. Agency side.',
        parameters: [orgParam],
        responses: { 200: { description: 'Stored branding values.' }, ...standardErrors },
      },
      patch: {
        tags: ['White label'],
        summary: 'Set the logo and colours',
        description: [
          'An agency selling monitoring to its clients should not hand over reports headed with a product they do not own, so the client facing surface presents the agency logo and colours instead.',
          'The logo must be an https URL and the colours must be hex. Applied to client facing pages and emails only. The agency own interface deliberately keeps DMARC Harbor branding, so support stays unambiguous.',
          'Requires the branding.whitelabel entitlement, so it is an Admiralty feature.',
        ].join(' '),
        parameters: [orgParam],
        responses: { ...standardErrors, 200: { description: 'Branding updated.' }, 400: { description: 'The logo or colour is not usable.' } },
      },
    },
    '/workspaces/{organizationId}/branding/custom-domain': {
      put: {
        tags: ['White label'],
        summary: 'Set the custom domain clients see',
        description: [
          'Returns a TXT record to publish, on the same ownership proof pattern as domain verification.',
          'The custom domain is not used until the record is verified, so a half configured agency cannot serve a broken portal to a client.',
        ].join(' '),
        parameters: [orgParam],
        responses: { ...standardErrors, 200: { description: 'Saved, with the record to publish.' } },
      },
    },
    '/workspaces/{organizationId}/branding/custom-domain/verify': {
      post: {
        tags: ['White label'],
        summary: 'Verify the custom domain',
        description: 'Reads the TXT record and marks the domain usable. Recorded in the audit trail the first time it succeeds.',
        parameters: [orgParam],
        responses: { ...standardErrors, 200: { description: 'Verification result.' } },
      },
    },
    '/trust/{slug}': {
      get: {
        tags: ['Trust Center'],
        security: [],
        summary: 'The public Trust Center for one client',
        description: [
          'A public, unauthenticated page an enterprise auditor opens from a link their IT provider forwarded. No account is required, and none is asked for.',
          'The slug is random and rotatable, because an enumerable address would disclose which clients an agency serves. Withdrawing the link answers exactly as an address that never existed, so the endpoint cannot be used to enumerate clients either.',
          'Only the client the slug belongs to appears. A workspace holds many clients, so the payload is scoped to the client and never to the workspace.',
          'Requires the trust.center entitlement to publish. The page is the public statement that this client is isolated from every other.',
        ].join(' '),
        parameters: [{ name: 'slug', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          ...standardErrors,
          200: { description: 'What is held for this client, who can read it, and how long it is kept.' },
          404: { description: 'No Trust Center at this address, or it was withdrawn.' },
        },
      },
    },
    '/workspaces/{organizationId}/clients/{clientId}/trust-center': {
      get: {
        tags: ['Trust Center'],
        summary: 'Whether this client has a published Trust Center',
        description: 'Reading is harmless, so it is allowed on every plan. Creating one is what publishes a claim, and that is gated.',
        parameters: [
          { name: 'organizationId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'clientId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { 200: { description: 'The slug and public URL, or null when unpublished.' }, ...standardErrors },
      },
      post: {
        tags: ['Trust Center'],
        summary: 'Publish a Trust Center for this client',
        description:
          'Idempotent. Calling it again returns the existing link rather than rotating it, because a link already forwarded to an auditor would otherwise stop working for no reason.',
        parameters: [
          { name: 'organizationId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'clientId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          ...standardErrors,
          200: { description: 'The public URL and slug.' },
          402: { description: 'The trust.center entitlement is not on this plan.' },
          404: { description: 'That client is not in this workspace.' },
        },
      },
      delete: {
        tags: ['Trust Center'],
        summary: 'Withdraw the public Trust Center',
        description:
          'A page that has been shared cannot be recalled, so the link is the thing that can be pulled. An agency that stops working with a client withdraws it here.',
        parameters: [
          { name: 'organizationId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'clientId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { 200: { description: 'Withdrawn.' }, ...standardErrors },
      },
    },
    '/compliance-packs/verify': {
      get: {
        tags: ['Trust Center'],
        security: [],
        summary: 'Verify a compliance pack or monthly report against its published digest',
        description: [
          'Public and unauthenticated, because the person verifying a document is an auditor at the client organisation holding the file and with no account here.',
          'Returns the digest, dates and kind for a document reference, and nothing else. Monthly reports also return their period. No client name, no domain, no personal data, so it cannot be used as a public directory of clients.',
          'Deliberately not routed under /trust/{slug}, because a literal path there would be captured by that parameter and answer a confusing 404.',
        ].join(' '),
        parameters: [{ name: 'reference', in: 'query', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: 'The published digest, with the instructions and the limits of what it proves.' },
          404: { description: 'No document with that reference.' },
        },
      },
    },
    '/workspaces/{organizationId}/clients/{clientId}/compliance-packs': {
      get: {
        tags: ['Trust Center'],
        summary: 'Packs previously issued for this client',
        description: 'Newest first, including superseded documents, because an auditor may still be holding an older copy.',
        parameters: [
          { name: 'organizationId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'clientId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { 200: { description: 'Issued packs with their digests.' }, ...standardErrors },
      },
      post: {
        tags: ['Trust Center'],
        summary: 'Issue a signed compliance pack',
        description: [
          'Streams the PDF with its digest in the X-DMARC-Pack-Sha256 header, so a reader never has to ask for the value separately.',
          'The digest is deliberately not printed inside the document. A file cannot contain its own digest, because writing it in changes the file and therefore the digest. The document carries a reference instead and the digest is published here.',
          'A self attestation. It proves the document is unaltered since issue, not that the provider is trustworthy.',
        ].join(' '),
        parameters: [
          { name: 'organizationId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'clientId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          ...standardErrors,
          200: {
            description: 'The PDF.',
            headers: {
              'X-DMARC-Pack-Sha256': { schema: { type: 'string' }, description: 'SHA-256 of the exact bytes served.' },
              'X-DMARC-Pack-Reference': { schema: { type: 'string' }, description: 'Document reference, quoted in the PDF.' },
            },
          },
          402: { description: 'The reports.compliancePack entitlement is not on this plan.' },
        },
      },
    },
    '/workspaces/{organizationId}/clients/{clientId}/monthly-reports': {
      get: {
        tags: ['Reports'],
        summary: 'Monthly evidence reports issued for this client',
        description: 'Newest first, at most 24, including superseded documents because an auditor may still hold the earlier copy.',
        parameters: [
          { name: 'organizationId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'clientId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { 200: { description: 'The report history with references, digests and download availability.' }, ...standardErrors },
      },
      post: {
        tags: ['Reports'],
        summary: 'Issue one monthly evidence report',
        description: [
          'The month must be complete, no older than 12 months, and no earlier than the client creation month.',
          'Streams the PDF with the same X-DMARC-Pack-Sha256 and X-DMARC-Pack-Reference headers as the compliance pack. Re-issuing a month supersedes the previous report for that client and month; both remain verifiable.',
          'Rate limited to 20 issues per workspace per hour.',
        ].join(' '),
        parameters: [
          { name: 'organizationId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'clientId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['period'],
                properties: { period: { type: 'string', pattern: '^\\d{4}-(0[1-9]|1[0-2])$', example: '2026-10' } },
              },
            },
          },
        },
        responses: {
          200: { description: 'The PDF, with its digest and reference in headers.' },
          ...standardErrors,
          402: { description: 'The reports.compliancePack entitlement is not on this plan.' },
          413: { description: 'The rendered report exceeds the 4 MB storage cap.' },
        },
      },
    },
    '/workspaces/{organizationId}/clients/{clientId}/monthly-reports/{reportId}/download': {
      get: {
        tags: ['Reports'],
        summary: 'Download a stored monthly report',
        description: 'Returns the exact stored bytes after recomputing the digest. A file past its retention window answers 410; its fingerprint still verifies.',
        parameters: [
          { name: 'organizationId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'clientId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'reportId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          200: { description: 'The stored PDF.' },
          ...standardErrors,
          410: { description: 'The report file is no longer held.' },
        },
      },
    },
    '/workspaces/{organizationId}/clients/{clientId}/monthly-report-schedule': {
      get: {
        tags: ['Reports'],
        summary: 'The monthly report schedule for one client',
        description: 'Read is available to client readers. A client with no schedule answers `{ schedule: null }`.',
        parameters: [
          { name: 'organizationId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'clientId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { 200: { description: 'The schedule, or null.' }, ...standardErrors },
      },
      put: {
        tags: ['Reports'],
        summary: 'Create or replace a monthly report schedule',
        description: 'The day is limited to 1-28 so every month has one. Recipients are trimmed, lowercased, de-duplicated and limited to 20.',
        parameters: [
          { name: 'organizationId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'clientId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['dayOfMonth', 'sendHourUtc', 'recipientEmails'],
                properties: {
                  enabled: { type: 'boolean' },
                  dayOfMonth: { type: 'integer', minimum: 1, maximum: 28 },
                  sendHourUtc: { type: 'integer', minimum: 0, maximum: 23 },
                  recipientEmails: { type: 'array', maxItems: 20, items: { type: 'string', format: 'email' } },
                },
              },
            },
          },
        },
        responses: { 200: { description: 'The saved schedule.' }, ...standardErrors },
      },
      delete: {
        tags: ['Reports'],
        summary: 'Remove a monthly report schedule',
        description: 'Removes the schedule, not the reports it already issued.',
        parameters: [
          { name: 'organizationId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'clientId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { 204: { description: 'Removed.' }, ...standardErrors },
      },
    },
    '/monthly-reports/download': {
      get: {
        tags: ['Reports'],
        security: [],
        summary: 'Download a monthly report from an emailed link',
        description: [
          'Public and unauthenticated: the recipient is the agency client, not a signed in member.',
          'Only the SHA-256 of the token is stored, so a database read cannot reconstruct the link. Unknown, expired and malformed tokens answer the same 404. Rate limited to 20 attempts per address per minute.',
        ].join(' '),
        parameters: [{ name: 'token', in: 'query', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: 'The stored PDF.' },
          404: { description: 'The link is not available.' },
          429: { description: 'Too many attempts.' },
        },
      },
    },
    '/portal/clients/{clientId}/monthly-reports': {
      get: {
        tags: ['Client portal'],
        summary: 'Monthly reports a client contact can download',
        description: 'Scoped by the portal grant, not by the path. Only non-superseded reports are returned.',
        parameters: [{ name: 'clientId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'The reports available to this contact.' }, ...standardErrors },
      },
    },
    '/portal/clients/{clientId}/monthly-reports/{reportId}/download': {
      get: {
        tags: ['Client portal'],
        summary: 'Download a monthly report as a client contact',
        description: 'A contact of another client gets the same 404 as an unknown report. Superseded reports are not downloadable from the portal.',
        parameters: [
          { name: 'clientId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'reportId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { 200: { description: 'The stored PDF.' }, ...standardErrors },
      },
    },
    '/workspaces/{organizationId}/billing': {
      get: {
        tags: ['Billing'],
        summary: 'What this workspace is paying for right now',
        description: [
          'Reports the effective plan, so a workspace mid cancellation still shows the plan it has paid for until the period ends.',
          'For a per-domain plan it also returns the stored quantity, the unit price, the total, and the quantity measured for the next period. Every workspace gets a Fleet quote computed with Fleet\'s 30 day active-domain window.',
        ].join(' '),
        responses: { 200: { description: 'Current plan, status, period end, price and per-domain quantity fields.' }, ...standardErrors },
      },
    },
    '/workspaces/{organizationId}/billing/checkout': {
      post: {
        tags: ['Billing'],
        summary: 'Start a subscription checkout',
        description: [
          'Returns a hosted page on the payment provider. No card data ever reaches this server.',
          'Nothing marks the workspace as paid here. The plan changes only when a signature verified webhook confirms the money moved, because a customer closing the tab is indistinguishable from success if you trust the redirect.',
          'INR checkouts route to Razorpay, which settles into an Indian bank account. Other currencies route to Paddle, which is the merchant of record and handles international sales tax.',
          'For a per-domain plan the quantity is measured server side from the account\'s active domains, with the plan minimum as the floor. A quantity in the request body is ignored.',
        ].join(' '),
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['plan', 'contact'],
                properties: {
                  plan: { type: 'string', enum: ['FAIRWAY', 'HARBOR', 'ADMIRALTY', 'FLEET'] },
                  interval: { type: 'string', enum: ['monthly', 'annual'], default: 'monthly' },
                  currency: { type: 'string', enum: ['USD', 'INR'], default: 'INR' },
                  contact: {
                    type: 'object',
                    required: ['name', 'email'],
                    properties: {
                      name: { type: 'string' },
                      email: { type: 'string', format: 'email' },
                      taxId: {
                        type: 'string',
                        nullable: true,
                        description: 'GSTIN. Indian businesses above the registration threshold need it on the invoice.',
                      },
                    },
                  },
                },
              },
            },
          },
        },
        responses: {
          ...standardErrors,
          201: { description: 'A hosted checkout URL.' },
          402: { description: 'The plan exists but this workspace cannot currently buy it.' },
          409: { description: 'This workspace already has an active subscription.' },
          503: { description: 'The provider is not configured, or its plans have not been synced.' },
        },
      },
    },
    '/workspaces/{organizationId}/billing/plan': {
      patch: {
        tags: ['Billing'],
        summary: 'Move to a different plan',
        description: [
          'Timing depends on the provider and is returned, not assumed. On Razorpay the change is scheduled for the end of the paid period with no proration, and the answer is status "scheduled" with that date. Paddle cannot schedule a price change, so it applies at once and prorates the rest of the period, and the answer is status "applied".',
          'A move to a smaller plan is refused with PLAN_CHANGE_OVER_QUOTA while the workspace is over that plan\'s limits.',
          'Moving to the free plan is treated as a cancellation, so the workspace keeps the period already paid for.',
        ].join(' '),
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['plan'],
                properties: {
                  plan: { type: 'string', enum: ['MOORING', 'FAIRWAY', 'HARBOR', 'ADMIRALTY', 'FLEET'] },
                  interval: { type: 'string', enum: ['monthly', 'annual'], default: 'monthly' },
                },
              },
            },
          },
        },
        responses: { 200: { description: 'The change is scheduled for the end of the current period.' }, ...standardErrors },
      },
    },
    '/workspaces/{organizationId}/billing/cancel': {
      post: {
        tags: ['Billing'],
        summary: 'Cancel, keeping access until the paid period ends',
        description: 'The workspace keeps the plan it paid for, then drops to the free plan when the period lapses. No data is ever removed.',
        responses: { 200: { description: 'Cancelled, with the date access ends.' }, ...standardErrors },
      },
    },
    '/workspaces/{organizationId}/billing/resume': {
      post: {
        tags: ['Billing'],
        summary: 'Undo a pending cancellation or scheduled plan change',
        description:
          'Only useful before the period ends. Once the period lapses the workspace is on the free plan and must start a new checkout instead.',
        responses: { 200: { description: 'The subscription will continue.' }, ...standardErrors },
      },
    },
    '/workspaces/{organizationId}/billing/portal': {
      post: {
        tags: ['Billing'],
        summary: 'Open the provider hosted billing portal',
        description: 'Paddle offers a full portal. Razorpay does not, and reports that plainly rather than pretending one exists.',
        responses: {
          ...standardErrors,
          200: { description: 'A portal URL.' },
          409: { description: 'No billing account yet.' },
          501: { description: 'This provider has no portal.' },
        },
      },
    },
    '/workspaces/{organizationId}/billing/plan-sync': {
      get: {
        tags: ['Billing'],
        summary: 'Which provider plans still need creating',
        description:
          'Operator view. A plan with no stored mapping cannot be sold, so checkout refuses it rather than guessing a price. Reports price drift when the stored price no longer matches the catalog.',

        parameters: [
          { name: 'provider', in: 'query', required: false, schema: { type: 'string', enum: ['RAZORPAY', 'PADDLE'] } },
          { name: 'currency', in: 'query', required: false, schema: { type: 'string', enum: ['USD', 'INR'] } },
        ],
        responses: { ...standardErrors, 200: { description: 'Sync status per plan.' } },
      },
    },
    '/webhooks/razorpay': {
      post: {
        tags: ['Billing'],
        security: [],
        summary: 'Razorpay payment webhook',
        description: [
          'The signature covers the exact bytes sent, so the raw body is preserved and never re-serialised.',
          'Every event is deduplicated on the provider event id before it can change anything, because both providers redeliver until acknowledged and often out of order.',
        ].join(' '),
        parameters: [{ name: 'x-razorpay-event', in: 'header', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Accepted, including duplicates and unrecognised events.' }, 401: { description: 'Bad signature.' }, 503: { description: 'Webhooks are not configured.' } },
      },
    },
    '/webhooks/paddle': {
      post: {
        tags: ['Billing'],
        security: [],
        summary: 'Paddle payment webhook',
        description: 'Verified with a timestamped HMAC, and a signature outside a five minute window is rejected so an old but valid one cannot be replayed.',
        responses: { 200: { description: 'Accepted, including duplicates and unrecognised events.' }, 401: { description: 'Bad or stale signature.' }, 503: { description: 'Webhooks are not configured.' } },
      },
    },
    '/workspaces/{organizationId}/branding/logo/store': {
      post: {
        tags: ['White label'],
        summary: 'Upload and store a logo',
        description: [
          'Takes the raw image bytes and stores them, recording the result as this workspace logo in the same request.',
          'This is the path the console uses. The presigned alternative makes a small upload depend on the browser reproducing a signature exactly, and when it does not the operator sees a bare network error with nothing on the server to diagnose it from.',
          'The declared content type is checked against the file itself, so a payload wearing an image content type is refused rather than stored and served from our origin.',
          'Accepted: SVG, PNG, JPEG and WebP, up to 256KB. SVG is accepted because assets are served from a separate origin under a sandbox content security policy, which disables script execution even on a direct navigation.',
        ].join(' '),
        requestBody: {
          required: true,
          content: {
            'image/svg+xml': { schema: { type: 'string', format: 'binary' } },
            'image/png': { schema: { type: 'string', format: 'binary' } },
            'image/jpeg': { schema: { type: 'string', format: 'binary' } },
            'image/webp': { schema: { type: 'string', format: 'binary' } },
          },
        },
        responses: {
          201: { description: 'Stored, with the object key, the public URL and the updated branding.' },
          ...standardErrors,
        },
      },
    },
    '/workspaces/{organizationId}/branding/logo/upload': {
      post: {
        tags: ['White label'],
        summary: 'Request a URL to upload a logo',
        description: [
          'Returns a presigned URL. The file goes straight from the browser to object storage and never passes through this server, which is what keeps binary handling, request body limits and memory pressure out of the API.',
          'The content type and size are checked here, before the URL is issued. That is the only point at which an upload can be constrained, because a presigned URL cannot be revoked once handed out.',
          'Accepted: SVG, PNG, JPEG and WebP, up to 256KB. SVG is safe here because assets are served from a separate origin under a sandbox content security policy, which disables script execution even on a direct navigation.',
        ].join(' '),
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['contentType', 'byteSize'],
                properties: {
                  contentType: { type: 'string', enum: ['image/svg+xml', 'image/png', 'image/jpeg', 'image/webp'] },
                  byteSize: { type: 'integer', description: 'Declared size, checked against the 256KB cap.' },
                },
              },
            },
          },
        },
        responses: {
          ...standardErrors,
          201: { description: 'A presigned upload URL, the object key and the public URL it will be served from.' },
          400: { description: 'The file type is not an accepted image.' },
          413: { description: 'The file is larger than the cap.' },
          503: { description: 'Object storage is not configured.' },
        },
      },
    },
    '/workspaces/{organizationId}/branding/logo/confirm': {
      post: {
        tags: ['White label'],
        summary: 'Use a just uploaded object as this workspace logo',
        description: [
          'Separate from issuing the URL because uploading and saving are different steps. An object can exist while the agency never confirms it, which is an orphan rather than a branding setting, and a storage lifecycle rule sweeps those.',
          'The key must be inside this workspace prefix. A key from elsewhere is refused, or a tenant could point its portal at another tenant asset.',
          'The previous logo is deleted, so repeated rebranding does not accumulate files.',
        ].join(' '),
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['objectKey'],
                properties: { objectKey: { type: 'string' } },
              },
            },
          },
        },
        responses: {
          ...standardErrors,
          200: { description: 'The resolved branding.' },
          404: { description: 'That upload does not belong to this workspace.' },
        },
      },
    },
    '/branding/host': {
      get: {
        tags: ['White label'],
        security: [],
        summary: 'Which agency serves this hostname',
        description: [
          'Resolves the agency for the hostname the request arrived on, so a white labelled portal knows whose brand to render before anybody has signed in.',
          'No authentication is required and only branding is returned, never clients, domains or counts. A hostname that has never been verified returns 404, so an unverified or removed domain cannot be used to discover an agency.',
        ].join(' '),
        parameters: [
          {
            name: 'Host',
            in: 'header',
            required: true,
            schema: { type: 'string' },
            description: 'The hostname of the custom domain, as sent by the browser.',
          },
        ],
        responses: {
          200: { description: 'The branding for the agency that owns this hostname.' },
          ...standardErrors,
        },
      },
    },
    '/portal/branding': {
      get: {
        tags: ['White label'],
        summary: 'Branding a client contact should render',
        description: [
          'Resolved from the portal scope, so a contact always sees their own agency branding.',
          'The workspace name is always present. The logo, colours and custom domain are only returned when the plan includes white labelling, and the custom domain only once its DNS record is verified.',
        ].join(' '),
        responses: { 200: { description: 'Branding for the client facing surface.' }, ...standardErrors },
      },
    },
    '/workspaces/{organizationId}/branding/resolved': {
      get: {
        tags: ['White label'],
        summary: 'Branding after licensing is applied',
        description: 'Same resolution as the portal endpoint, for the agency interface, so a workspace on a plan without white labelling can be shown what clients actually see.',
        parameters: [orgParam],
        responses: { 200: { description: 'Resolved branding.' }, ...standardErrors },
      },
    },
    '/workspaces/{organizationId}/report-inbox': {
      get: {
        tags: ['Report collection'],
        summary: 'Mailbox settings for emailed report collection',
        description: [
          'Returns the host, username and the last poll result, and never the password. The password is account level access, so it is stored encrypted and is not readable back through any endpoint.',
          'The mailbox is per workspace rather than per client, because the product works by pointing every monitored domain rua tag at one shared address, so no customer hands over IMAP credentials.',
        ].join(' '),
        parameters: [orgParam],
        responses: { ...standardErrors, 200: { description: 'Settings, with the password omitted.' } },
      },
      put: {
        tags: ['Report collection'],
        summary: 'Store or replace the mailbox',
        description: [
          'Replaces any previous mailbox, so a rotated password is applied by sending the new one rather than by editing the old.',
          'Requires the reports.inbox entitlement, which starts at Harbor. A loopback or non mail port is refused, so a misconfiguration cannot reach a service on our own network and present the result as customer data.',
        ].join(' '),
        parameters: [orgParam],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['host', 'username', 'password'],
                properties: {
                  host: { type: 'string', example: 'imap.migadu.com' },
                  port: { type: 'integer', description: 'Defaults to 993 for implicit TLS.' },
                  secure: { type: 'boolean', description: 'Defaults to true.' },
                  username: { type: 'string', example: 'agg@reports.dmarcharbor.com' },
                  password: { type: 'string', format: 'password' },
                },
              },
            },
          },
        },
        responses: { ...standardErrors, 200: { description: 'Stored, with the password omitted.' }, 400: { description: 'The host or port is not a usable mail server.' } },
      },
      delete: {
        tags: ['Report collection'],
        summary: 'Stop collection and discard the mailbox',
        description: 'Deletes the stored credentials. The messages themselves remain in the mail provider account and are removed there.',
        parameters: [orgParam],
        responses: { ...standardErrors, 204: { description: 'Removed.' } },
      },
    },
    '/workspaces/{organizationId}/report-inbox/poll': {
      post: {
        tags: ['Report collection'],
        summary: 'Poll the mailbox now',
        description: [
          'The scheduler polls on its own interval, so this exists for the case where a rua tag has just been pointed at us and the answer is wanted without waiting for the next cycle.',
          'Returns what was found. A report already held is reported as a duplicate rather than skipped silently, because a sender split across DNS and email is normal and is the reason identity deduplication exists.',
        ].join(' '),
        parameters: [orgParam],
        responses: { ...standardErrors, 200: { description: 'Counts of messages, accepted, duplicates and unmatched.' } },
      },
    },
    '/workspaces/{organizationId}/sso-connections': {
      get: {
        tags: ['Single sign on'],
        summary: 'Configured identity provider connections',
        description: [
          'Returns the connection settings and the email domains each one admits. The provider client secret is not part of this payload and is never returned by any endpoint.',
          'Requires the auth.sso entitlement, which is sold on Admiralty only.',
        ].join(' '),
        parameters: [orgParam],
        responses: { ...standardErrors, 200: { description: 'The connections this workspace trusts.' } },
      },
      post: {
        tags: ['Single sign on'],
        summary: 'Trust an identity provider for this workspace',
        description: [
          'A workspace that already runs its staff through an identity provider should not have to manage a second set of credentials, and an auditor will ask why a tool holding every client domain and forensic report is reachable with a local password.',
          'Just in time provisioning is refused unless at least one permitted email domain is given. That allowlist is the entire security boundary: without it, anyone who can authenticate to any identity provider on the internet could provision themselves into the workspace by claiming an address at a domain they do not control.',
          'The default role may be analyst, viewer or admin. It cannot be owner, because provisioning is unattended and handing out ownership from a directory would mean anyone it contains could change the plan or invite others.',
        ].join(' '),
        parameters: [orgParam],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['label', 'protocol', 'issuer', 'entryPoint', 'clientId', 'clientSecret'],
                properties: {
                  label: { type: 'string' },
                  protocol: { type: 'string', enum: ['SAML', 'OIDC'] },
                  issuer: { type: 'string', description: 'SAML entity id, or the OIDC issuer to discover.' },
                  entryPoint: { type: 'string', description: 'SAML SSO url, or the OIDC callback url for this connection.' },
                  clientId: { type: 'string' },
                  clientSecret: { type: 'string', format: 'password' },
                  idpCertificate: { type: 'string', description: 'IdP certificate, for SAML signature validation.' },
                  provisioning: { type: 'string', enum: ['JIT', 'DISABLED'], default: 'JIT' },
                  allowedEmailDomains: { type: 'array', items: { type: 'string' }, maxItems: 50 },
                  defaultRole: { type: 'string', enum: ['analyst', 'viewer', 'admin'], default: 'analyst' },
                },
              },
            },
          },
        },
        responses: { ...standardErrors, 201: { description: 'The connection id.' }, 400: { description: 'The details are unusable, or provisioning was asked for with no permitted domain.' } },
      },
    },
    '/workspaces/{organizationId}/sso-connections/{connectionId}': {
      patch: {
        tags: ['Single sign on'],
        summary: 'Switch a connection on or off, or change who it admits',
        description: [
          'Changes only the parts an administrator adjusts after setup: whether the connection is on, its label, the permitted email domains, provisioning and the default role.',
          'The identity provider details (protocol, issuer, entry point, client id and secret, certificate) cannot be changed here. An unknown field is refused rather than ignored; to change the provider, add a new connection.',
          'The same rules as creation apply to the result: provisioning stays refused without a permitted domain, and the default role cannot be owner. Requires organization:update and the auth.sso entitlement.',
        ].join(' '),
        parameters: [orgParam, connectionParam],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                additionalProperties: false,
                minProperties: 1,
                properties: {
                  enabled: { type: 'boolean' },
                  label: { type: 'string' },
                  allowedEmailDomains: { type: 'array', items: { type: 'string' }, maxItems: 50 },
                  provisioning: { type: 'string', enum: ['JIT', 'DISABLED'] },
                  defaultRole: { type: 'string', enum: ['analyst', 'viewer', 'admin'] },
                },
              },
            },
          },
        },
        responses: {
          ...standardErrors,
          200: { description: 'The connection as it now stands, without the client secret.' },
          400: { description: 'An unknown field was sent, or the result would provision with no permitted domain.' },
        },
      },
      delete: {
        tags: ['Single sign on'],
        summary: 'Stop trusting a provider',
        description: 'Scoped to this workspace, so a connection id belonging to another workspace removes nothing.',
        parameters: [orgParam, connectionParam],
        responses: { ...standardErrors, 204: { description: 'Removed.' } },
      },
    },
    '/sso/{connectionId}': {
      get: {
        tags: ['Single sign on'],
        security: [],
        summary: 'Name the workspace and connection for a sign in page',
        description: [
          'Public and unauthenticated, because a person about to enter a work password somewhere should see whose workspace they are logging in to. A site claiming to be this workspace is then obvious.',
          'A connection id is a capability for starting a sign in, not a way past the allowlist. Knowing it does not change what the returned assertion has to satisfy.',
        ].join(' '),
        parameters: [connectionParam],
        responses: { ...standardErrors, 200: { description: 'The workspace name and protocol.' } },
      },
    },
    '/sso/{connectionId}/start': {
      get: {
        tags: ['Single sign on'],
        security: [],
        summary: 'Begin a sign in',
        description: [
          'Redirects to the provider. OIDC uses the authorization code flow with PKCE and a single use state, so an intercepted code cannot be redeemed and a captured response cannot be replayed.',
          'SAML builds a signed AuthnRequest, because a provider configured to require one will refuse a bare redirect.',
        ].join(' '),
        parameters: [connectionParam],
        responses: { ...standardErrors, 302: { description: 'Redirect to the identity provider.' } },
      },
    },
    '/sso/{connectionId}/callback': {
      get: {
        tags: ['Single sign on'],
        security: [],
        summary: 'OIDC callback',
        description: [
          'Verifies the id token against the provider published keys and the audience, then checks the email domain allowlist before any account is created. On success a normal session cookie is set, so the rest of the product cannot tell this apart from a password sign in.',
          'The state is single use, so a response captured from a browser cannot be replayed into a second session.',
        ].join(' '),
        parameters: [connectionParam],
        responses: { ...standardErrors, 302: { description: 'Signed in and redirected to the portal.' }, 403: { description: 'The email domain is not permitted for this connection.' } },
      },
    },
    '/sso/{connectionId}/saml/acs': {
      post: {
        tags: ['Single sign on'],
        security: [],
        summary: 'SAML assertion consumer',
        description: 'The assertion or the response must be signed by the configured IdP certificate, and the audience and destination are checked before the identity is trusted.',
        parameters: [connectionParam],
        responses: { ...standardErrors, 302: { description: 'Signed in and redirected to the portal.' } },
      },
    },
    '/billing/reconcile': {
      post: {
        tags: ['Billing'],
        security: [{ staffKey: [] }],
        summary: 'Reconcile billing state now, on demand',
        description: [
          'Compares every subscription against its payment provider immediately, instead of waiting for the scheduled run. Exists for the case where six hours is too long to answer a question a customer is already asking, such as "I paid an hour ago and my plan has not changed".',
          'Optional organizationId narrows the sweep to one subscription, which is what support usually wants and avoids a provider API call per customer.',
          'Staff only, on the same credential as plan changes. An endpoint that makes outbound provider calls on demand is not something a workspace role should reach.',
          'Safe to call repeatedly. The event identifier is deterministic, so a reconciliation that races the real webhook recognises it as a duplicate and does nothing.',
        ].join(' '),
        parameters: [
          {
            name: 'organizationId',
            in: 'query',
            required: false,
            schema: { type: 'string' },
            description: 'Reconcile only this workspace. Omit to sweep every subscription.',
          },
        ],
        responses: {
          200: { description: 'What was examined, and what was repaired.' },
          404: { description: 'That workspace has no provider subscription to reconcile.' },
        },
      },
    },
    '/auth/providers': {
      get: {
        tags: ['System'],
        security: [],
        summary: 'Which sign-in methods this deployment offers',
        description: [
          'Read by the sign-in page, so it takes no authentication and is deliberately mounted ahead of the session middleware.',
          'Social providers are conditional on an OAuth application being registered for this environment, so the answer differs between a laptop and production. Hardcoding the buttons means either dead buttons in development or missing ones in production.',
          'Returns only whether each provider is configured. No client id and no authorisation url, nothing that could be turned into a token.',
        ].join(' '),
        responses: {
          200: { description: 'Which of password, google and microsoft are available here.' },
        },
      },
    },
    '/workspaces/{organizationId}/slack-destination': {
      get: {
        tags: ['Settings'],
        summary: 'Read the workspace Slack destination',
        description: [
          'One destination per workspace rather than per user, because a Slack channel is shared by everyone in it.',
          'The webhook URL is a credential: anyone holding it can post to the channel. It is stored encrypted and returned masked, never in full.',
          'Returns null when no destination is configured.',
        ].join(' '),
        responses: { 200: { description: 'The masked destination, or null.' } },
      },
      put: {
        tags: ['Settings'],
        summary: 'Configure the workspace Slack destination',
        description: [
          'Accepts a Slack incoming-webhook URL and validates it before storing: https only, host must be exactly hooks.slack.com, no explicit port, no embedded credentials, and the path must look like an incoming webhook.',
          'The host check is an exact match rather than a suffix match, because a suffix check accepts a host the customer controls and turns this into a request forwarder.',
          'Replaces any existing destination and clears its failure count, since a new webhook is a fresh start.',
        ].join(' '),
        responses: {
          200: { description: 'The saved destination, masked.' },
          400: { description: 'The webhook URL was refused.' },
        },
      },
      patch: {
        tags: ['Settings'],
        summary: 'Enable or disable the Slack destination',
        description: [
          'Turning this off stops new posts and keeps the stored webhook, so the channel can be re-enabled without pasting it again.',
          'Disabling is not a rotation. To invalidate a webhook that may have leaked, delete the destination and create a new one in Slack.',
        ].join(' '),
        responses: {
          204: { description: 'Updated.' },
          404: { description: 'No destination is configured.' },
        },
      },
      delete: {
        tags: ['Settings'],
        summary: 'Remove the Slack destination',
        description: [
          'Stops alerts reaching the channel and discards the stored webhook URL.',
          'The webhook stays valid in Slack until it is deleted there, so removing it here is not the same as revoking it.',
        ].join(' '),
        responses: { 204: { description: 'Removed.' } },
      },
    },
    '/workspaces/{organizationId}/dns-connections': {
      get: {
        tags: ['DNS automation'],
        summary: 'List Cloudflare connections',
        description: [
          'Returns each connection with its label, the last four characters of the token, verification time and last error.',
          'The token itself is never returned. paused is true when the plan no longer grants dns.automation; the connection is kept so it can be removed or resumed.',
        ].join(' '),
        parameters: [orgParam],
        responses: { 200: { description: 'Connections, without any usable credential.' }, ...standardErrors },
      },
      post: {
        tags: ['DNS automation'],
        summary: 'Connect a Cloudflare API Token',
        description: [
          'Verifies the token with Cloudflare before saving it. The token must be active; a Global API Key (37 hex characters) is refused with an explanation because it grants account-wide access.',
          'The token is stored encrypted and only its last four characters are ever returned. Requires dns.automation; a plan without it answers 402.',
          'At most five connections may exist in a workspace.',
        ].join(' '),
        parameters: [orgParam],
        responses: {
          ...standardErrors,
          201: { description: 'Connection created, with tokenHint only.' },
          402: { description: 'DNS automation is not included in this workspace plan.' },
          409: { description: 'The five-connection limit was reached.' },
        },
      },
    },
    '/workspaces/{organizationId}/dns-connections/{connectionId}': {
      delete: {
        tags: ['DNS automation'],
        summary: 'Remove a Cloudflare connection',
        description: [
          'Deletes the stored token. Publication history is kept with its connection reference cleared.',
          'Never plan-gated, so a downgraded workspace can always remove the credential it stored.',
        ].join(' '),
        parameters: [orgParam, idParam('connectionId', 'Connection identifier.')],
        responses: { 204: { description: 'Removed.' }, ...standardErrors },
      },
    },
    '/workspaces/{organizationId}/domains/{domainId}/dns-publish/preview': {
      post: {
        tags: ['DNS automation'],
        summary: 'Preview publishing one generated record',
        description: [
          'The client names a record kind; the server builds the name and value. Raw record text in the body is ignored, never written.',
          'Kinds are verification, dmarc_suggested, dmarc_policy, switch_dual and switch_cutover. dmarc_policy accepts policy, testing and np, and refuses pct.',
          'Returns the zone found, the current TXT values at the name, the proposed value, the action (create, update, unchanged or refused) and a SHA-256 fingerprint of the sorted current values.',
          'A name with two or more DMARC records, or with a CNAME, is refused. Other TXT records at the name are never touched.',
        ].join(' '),
        parameters: [orgParam, idParam('domainId', 'Domain identifier.')],
        responses: {
          ...standardErrors,
          200: { description: 'The preview and its fingerprint.' },
          402: { description: 'DNS automation is not included in this workspace plan.' },
          404: { description: 'The domain or connection is not in this workspace, or no zone is visible to the token.' },
        },
      },
    },
    '/workspaces/{organizationId}/domains/{domainId}/dns-publish': {
      post: {
        tags: ['DNS automation'],
        summary: 'Publish one generated record',
        description: [
          'Re-reads Cloudflare and compares the fingerprint from the preview. A changed fingerprint answers 409 DNS_CHANGED with the new preview; nothing is overwritten.',
          'Applies exactly one create or update. This endpoint never deletes a record; restoring a publication can delete a record it created.',
          'Rate limited to 30 publishes per workspace per hour.',
          'After success, verification re-checks ownership and DMARC kinds run a manual scan. A failure in that refresh does not fail the publish. DNS propagation may take a few minutes.',
          'A successful publish is recorded in the audit trail and in the publication history.',
        ].join(' '),
        parameters: [orgParam, idParam('domainId', 'Domain identifier.')],
        responses: {
          ...standardErrors,
          200: { description: 'Published, unchanged, and the publication history entry.' },
          400: { description: 'The record kind or its parameters were refused.' },
          402: { description: 'DNS automation is not included in this workspace plan.' },
          409: { description: 'DNS_CHANGED with the new preview, or the publication cannot be applied.' },
          429: { description: 'The workspace publish rate limit was exceeded.' },
        },
      },
    },
    '/workspaces/{organizationId}/dns-publications/{publicationId}/restore': {
      post: {
        tags: ['DNS automation'],
        summary: 'Restore the value before a publication',
        description: [
          'Allowed for seven days after publishing, only once, and only while the record still holds the value that publication wrote.',
          'Puts the previous value back, or deletes the record when the publication created it. A record changed in Cloudflare in the meantime is refused with 409 RECORD_CHANGED.',
          'If the connection used was removed, the record has to be restored in Cloudflare.',
        ].join(' '),
        parameters: [orgParam, idParam('publicationId', 'Publication identifier.')],
        responses: {
          ...standardErrors,
          200: { description: 'Restored or deleted.' },
          402: { description: 'DNS automation is not included in this workspace plan.' },
          404: { description: 'The publication is not in this workspace.' },
          409: { description: 'Expired, already restored, changed since, or the connection was removed.' },
        },
      },
    },
    '/workspaces/{organizationId}/billing/currency': {
      get: {
        tags: ['Billing'],
        summary: 'Read the currency this workspace is quoted and billed in',
        description: [
          'Reports whether the currency can still change, so the settings screen can disable the control and explain why rather than accepting a value and failing.',
          'The currency is not a display preference: INR routes to Razorpay and USD to Paddle, so changing it after a payment means migrating a live subscription between two processors.',
        ].join(' '),
        responses: { 200: { description: 'preferredCurrency, whether it is locked, and why.' } },
      },
      patch: {
        tags: ['Billing'],
        summary: 'Change the currency used by future checkouts',
        description: [
          'Accepted only before the workspace has a payment. Default is INR because Razorpay is the processor money can actually be taken with today.',
          'Returns 409 CURRENCY_LOCKED once a subscription exists.',
        ].join(' '),
        responses: {
          200: { description: 'The new preference.' },
          409: { description: 'A payment exists, so the currency is fixed.' },
        },
      },
    },
    '/.well-known/security.txt': {
      get: {
        tags: ['Compliance'],
        security: [],
        summary: 'RFC 9116 security contact',
        description: [
          'Served from the API as well as the application, because this is a header-only document and must not depend on a JavaScript runtime starting up.',
          'Publish a Contact, a Policy and an expiry. A missing expiry tells a researcher the file was abandoned, which is worse than not publishing one.',
        ].join(' '),
        responses: { 200: { description: 'text/plain security.txt' } },
      },
    },
    '/workspaces/{organizationId}/dpa-acceptance': {
      get: {
        tags: ['Compliance'],
        summary: 'Which version of the Data Processing Agreement this workspace has accepted',
        description: [
          'Reported per organisation rather than per user, because an agency accepts on behalf of its clients and a member leaving must not erase the record.',
          'Reports the accepted version alongside the current one, so an older acceptance can be prompted for again rather than treated as current.',
        ].join(' '),
        responses: { 200: { description: 'Accepted flag, accepted and current versions, whether re-consent is required, and who accepted.' } },
      },
      post: {
        tags: ['Compliance'],
        summary: 'Record acceptance of the Data Processing Agreement',
        description: [
          'Both confirmations are required: that the agreement has been read, and that the person accepting is authorised to bind the organisation.',
          'The second is the one that matters. An employee creating a workspace has not been authorised by their firm to accept a data processing agreement on its behalf.',
          'Recorded in the audit trail with the confirming IP, because a later dispute about authority is settled by a row rather than by memory.',
        ].join(' '),
        responses: {
          200: { description: 'The recorded acceptance.' },
          409: { description: 'Both confirmations were not supplied.' },
        },
      },
    },
    '/capabilities': {
      get: {
        tags: ['System'],
        security: [],
        summary: 'What this deployment can actually do',
        description: [
          'Public, because it is read by the marketing and pricing pages before anyone has an account.',
          'Answers which sign-in methods exist and which currencies can actually be paid in. Derived from provider configuration rather than a flag, so it cannot drift: adding PADDLE_API_KEY and PADDLE_WEBHOOK_SECRET is the whole of the change.',
          'This exists because the pricing page used to render every currency the catalog carries prices for, and therefore advertised a plan the checkout would then refuse. A public page must not promise something the API will not deliver.',
          'Exposes configuration state only: no keys, no identifiers, no counts.',
        ].join(' '),
        responses: { 200: { description: 'Purchasable currencies, default currency, provider readiness, and illustrative compliance pack identifiers.' } },
      },
    },
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
          'The four ladder plans with their limits, features and prices, followed by Fleet, which is billed per active domain. Public, so a pricing page can render before anyone signs up.',
          'Prices are returned in both USD cents and INR paise. The currency actually charged is whichever is selected at checkout.',
          'Mooring is free and covers two active domains. The paid prices are in the response, in USD and INR; this text does not repeat them so it cannot fall out of date.',
          'Fleet is monthly only, has a minimum quantity, and grants exactly Harbor features: no white label, logo upload or SSO. The public API (api.access) is included from Harbor; white label and SSO from Admiralty.',
          'Data export and erasure are included on every plan, because the right to access and delete personal data cannot be paywalled.',
        ].join(' '),
        responses: { 200: { description: 'Plan catalog.' } },
      },
    },
    '/workspaces/{organizationId}/erasures/preview': {
      get: {
        tags: ['Billing'],
        summary: 'Preview what an erasure would do',
        description: [
          'Returns the exact record counts that would be deleted, anonymised or kept, with the reason for each, before anything is touched. No database writes occur.',
          'Built from the same classification the export uses, so what an export includes and what an erasure removes can never disagree.',
          'The reason DMARC evidence is kept is that it contains no recipient data, while named recipients are deleted in full.',
        ].join(' '),
        parameters: [
          orgParam,
          { name: 'scope', in: 'query', required: true, schema: { type: 'string', enum: ['ORGANIZATION', 'CLIENT', 'DOMAIN'] } },
          { name: 'targetId', in: 'query', required: false, schema: { type: 'string' } },
        ],
        responses: { 200: { description: 'Planned actions, totals, grace period and statement.' }, ...standardErrors },
      },
    },
    '/workspaces/{organizationId}/erasures': {
      get: {
        tags: ['Billing'],
        summary: 'List erasure requests',
        description: 'Newest first, including the certificate for completed requests.',
        parameters: [orgParam, ...queryPagination],
        responses: { 200: { description: 'Erasure requests.' }, ...standardErrors },
      },
      post: {
        tags: ['Billing'],
        summary: 'Request an erasure',
        description: [
          'Included on every plan, including the free one, because the right to erasure cannot be a paid feature.',
          'The request is held for seven days before it runs, so an accidental request can be cancelled. The workspace owner is the only role that can request one.',
          'Scope to a client or a domain to erase only that data. Erasing a client or a domain never removes agency staff accounts or sessions.',
        ].join(' '),
        parameters: [orgParam],
        responses: {
          ...standardErrors,
          202: { description: 'Request created, pending, with the preview attached.' },
          404: { description: 'The client or domain is not in this workspace.' },
        },
      },
    },
    '/workspaces/{organizationId}/erasures/{erasureId}': {
      get: {
        tags: ['Billing'],
        summary: 'Erasure request detail',
        description: 'State, timings and the certificate, which contains no personal data and survives the erasure it describes.',
        parameters: [orgParam, idParam('erasureId', 'Erasure request identifier.')],
        responses: { 200: { description: 'Request detail and certificate.' }, ...standardErrors },
      },
    },
    '/workspaces/{organizationId}/erasures/{erasureId}/cancel': {
      post: {
        tags: ['Billing'],
        summary: 'Cancel a pending erasure',
        description: 'Stops a request that has not run yet. This is the safeguard against an accidental request.',
        parameters: [orgParam, idParam('erasureId', 'Erasure request identifier.')],
        responses: { ...standardErrors, 204: { description: 'Cancelled before execution.' }, 409: { description: 'The request is no longer pending.' } },
      },
    },
    '/workspaces/{organizationId}/erasures/{erasureId}/execute': {
      post: {
        tags: ['Billing'],
        summary: 'Execute an erasure now',
        description: [
          'Inside the seven day grace period this requires an explicit confirmation, because it is irreversible.',
          'Everything in scope is deleted, including DMARC reports, forensic samples and named recipient records; audit and billing records are kept with identifying fields cleared.',
          'A certificate is written before the deletes and survives them, so there is permanent proof the request was carried out.',
        ].join(' '),
        parameters: [orgParam, idParam('erasureId', 'Erasure request identifier.')],
        responses: { ...standardErrors, 200: { description: 'Completed, with the certificate.' }, 400: { description: 'Still inside the grace period and not confirmed.' } },
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
    '/workspaces/{organizationId}/refund-eligibility': {
      get: {
        tags: ['Billing'],
        summary: 'Whether this workspace can be refunded',
        description: [
          'Evaluates the published 30 day money back guarantee against the recorded purchase date.',
          'Read only, and safe to call during a support conversation. This exists because the guarantee was published with nothing to evaluate it against, so the only way to answer was to open a provider dashboard and read an invoice date.',
          'Returns an explicit refusal rather than a guess when no completed purchase is on record, and says which day the window ended when it has.',
        ].join(' '),
        parameters: [orgParam],
        responses: { 200: { description: 'Eligibility, with the reason either way.' }, ...standardErrors },
      },
    },
    '/workspaces/{organizationId}/refund': {
      post: {
        tags: ['Billing'],
        summary: 'Issue a refund',
        description: [
          'Refunds through the payment provider and records both the grant and any refusal, so a dispute about either can be answered later.',
          'Refuses a workspace outside the guarantee unless `overrideWindow` is set, which is recorded as a separate fact from a guarantee refund.',
          'Requires the staff credential rather than a workspace permission. Paying money out is not something the permission table should express, and the owner role holds billing:update.',
          'The provider response is the authority on whether money moved. Nothing is reported as refunded that the provider did not confirm.',
        ].join(' '),
        parameters: [orgParam],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['reason'],
                properties: {
                  reason: { type: 'string', description: 'Why this refund is being issued. Recorded.' },
                  overrideWindow: {
                    type: 'boolean',
                    description: 'Pay even though the guarantee has expired, as an explicit goodwill decision.',
                  },
                },
              },
            },
          },
        },
        responses: { 201: { description: 'Refund issued, with the provider reference.' }, ...standardErrors },
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
          {
            name: 'withinHours',
            in: 'query',
            required: false,
            schema: { type: 'integer', minimum: 1, maximum: 8760 },
            description:
              'Restrict to the last N hours. Omitted means every event. A value that is not a positive whole number is ignored rather than rejected, so a hand-edited URL widens to the full trail instead of erroring.',
          },
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
                  tosAccepted: {
                    type: 'boolean',
                    description: 'The Terms of Service has been read and accepted. Refused without it, on every plan.',
                  },
                  dpaHasRead: { type: 'boolean' },
                  dpaConfirmsAuthority: { type: 'boolean' },
                },
              },
            },
          },
        },
        responses: {
          201: { description: 'Workspace created.' },
          402: { description: 'The account holds no further workspace allowance.' },
          ...standardErrors,
        },
      },
    },
    '/workspaces/allowance': {
      get: {
        tags: ['Auth'],
        summary: 'Read the workspace allowance for the signed-in account',
        description:
          'How many workspaces the account may hold and how many it holds now. Read only: it exists so the create screen can state the limit before someone fills the form in, which attempting a creation to discover would spend an allowance to answer.',
        responses: {
          200: {
            description: 'The allowance.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    strongest: { type: 'string', description: 'The strongest plan the account holds, which sets the allowance.' },
                    maxWorkspaces: { type: 'integer' },
                    used: { type: 'integer' },
                    remaining: { type: 'integer' },
                    allowed: { type: 'boolean' },
                  },
                },
              },
            },
          },
          ...standardErrors,
        },
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
    '/me/security': {
      get: {
        tags: ['Auth'],
        summary: 'Read your two-step verification state',
        description: [
          'Account level and never workspace scoped, so a member blocked by a workspace requirement can still reach the screen that fixes it.',
          'Returns whether an authenticator app is on, whether the account has a password, how many backup codes remain, and which workspaces require two-step verification.',
        ].join(' '),
        responses: { 200: { description: 'The account security state.' }, ...standardErrors },
      },
    },
    '/workspaces/{organizationId}/members/{memberId}/mfa/reset': {
      post: {
        tags: ['Auth'],
        summary: 'Reset a member two-step verification',
        description: [
          'Owner only. Removes the authenticator secret and backup codes, clears the account flag, signs the member out everywhere and deletes trust-device records.',
          'The owner cannot reset their own account here; turning it off is an account action and needs the password.',
        ].join(' '),
        parameters: [orgParam, idParam('memberId', 'Member identifier from the member list.')],
        responses: {
          ...standardErrors,
          200: { description: 'Reset, signed out everywhere, and the member was emailed.' },
          400: { description: 'The owner targeted their own membership.' },
          403: { description: 'The caller is not the workspace owner.' },
          404: { description: 'No such member in this workspace.' },
        },
      },
    },
    '/workspaces/{organizationId}/security': {
      get: {
        tags: ['Auth'],
        summary: 'Read the workspace two-step requirement',
        description: 'Returns the requirement, when it last changed, and how many non-portal members have not enrolled.',
        parameters: [orgParam],
        responses: { 200: { description: 'The requirement and its reach.' }, ...standardErrors },
      },
      put: {
        tags: ['Auth'],
        summary: 'Set the workspace two-step requirement',
        description: [
          'Owner only. Turning it on requires the owner to satisfy it already, with an authenticator app or an SSO session, so the setting cannot lock its own author out.',
          'The refusal is 409 MFA_REQUIRED_FOR_CALLER and names the action to take first.',
        ].join(' '),
        parameters: [orgParam],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['requireMfa'],
                properties: { requireMfa: { type: 'boolean' } },
              },
            },
          },
        },
        responses: {
          ...standardErrors,
          200: { description: 'Saved, with the number of non-portal members still to enrol.' },
          409: { description: 'The owner has not set up two-step verification yet.' },
        },
      },
    },
    '/staff/users/{userId}/mfa/reset': {
      post: {
        tags: ['Auth'],
        security: [{ staffKey: [] }],
        summary: 'Reset any account two-step verification (staff)',
        description: [
          'Authorised by the deployment staff key, not by a workspace role. This is the recovery path for a sole owner who lost the authenticator and the backup codes.',
          'Requires a reason of 10 to 280 characters, recorded in the audit trail with the reset.',
        ].join(' '),
        parameters: [idParam('userId', 'Account identifier.')],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['reason'],
                properties: { reason: { type: 'string', minLength: 10, maxLength: 280 } },
              },
            },
          },
        },
        responses: {
          ...standardErrors,
          200: { description: 'Reset and signed out everywhere.' },
          400: { description: 'The reason is missing or outside 10 to 280 characters.' },
          404: { description: 'No such account.' },
        },
      },
    },
    '/scan': {
      post: {
        tags: ['Scanning'],
        summary: 'Public single domain scan',
        description:
          'Unauthenticated and rate limited. Returns a score and the issues found, without storing anything. It also reads MTA-STS, TLS-RPT and BIMI records and, when a policy or logo is published, fetches that HTTPS document through a guarded fetcher that refuses private addresses and does not follow redirects.',
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
    '/workspaces/{organizationId}/clients/{clientId}/domains/bulk': {
      post: {
        tags: ['Clients and domains'],
        summary: 'Add many domains to a client',
        description: [
          'The session-authenticated twin of POST /api/v1/domains/bulk, returning the same per-row verdicts.',
          'Exists because the public endpoint authenticates with a bearer API key, which a browser signed in with a cookie cannot present. Onboarding an agency that sent eighty domains otherwise meant calling the API by hand.',
          'Duplicates are reported per row rather than failing the request: a name already in the workspace is something the operator can remove from the list, and a 400 for the whole batch would throw away every row that was fine.',
          'A request over the per-call cap is refused with 402 and the limit in the error details, rather than being silently truncated.',
        ].join(' '),
        parameters: [orgParam, idParam('clientId', 'Client identifier.')],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['domains'],
                properties: {
                  domains: {
                    type: 'array',
                    minItems: 1,
                    items: { type: 'string' },
                    description: 'Domain names. Duplicates within the request are handled: the first is created and the rest are reported as duplicates.',
                  },
                },
              },
            },
          },
        },
        responses: {
          201: { description: 'Processed, with per-row verdicts for created, failed and plan-blocked rows.' },
          ...standardErrors,
        },
      },
    },
    '/workspaces/{organizationId}/clients/{clientId}/report-address': {
      get: {
        tags: ['Clients and domains'],
        summary: 'Read a client report address',
        description: [
          'The address this client publishes in rua. With per-client subaddressing it is personal to the client; otherwise it is the shared address.',
          'Personal addresses carry the client token in the local part. The token is published in DNS and is not a secret: its job is to identify the client and let a DMARC record prove ownership.',
        ].join(' '),
        parameters: [orgParam, idParam('clientId', 'Client identifier.')],
        responses: {
          200: { description: 'Aggregate and forensic addresses, the shared aggregate address, and whether the aggregate address is personal.' },
          ...standardErrors,
        },
      },
    },
    '/workspaces/{organizationId}/clients/{clientId}/switch-kit': {
      post: {
        tags: ['Clients and domains'],
        summary: 'Import domains for a provider switch',
        description: [
          'Creates new domains, reads each live DMARC record, identifies the incumbent provider and generates a dual reporting record.',
          'Names already in this client are included as existing. Rows the bulk domain import refuses or the plan blocks are returned unchanged and are not planned.',
          'DNS is checked with a concurrency limit and one 25 second deadline; a domain not reached by then is reported as not checked yet.',
          'A switch row is only created or refreshed while it is PLANNED. Domains already dual reporting or cut over keep their state.',
        ].join(' '),
        parameters: [orgParam, idParam('clientId', 'Client identifier.')],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['domains'],
                properties: {
                  domains: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string' } },
                },
              },
            },
          },
        },
        responses: {
          201: { description: 'Per-domain plans, verification records, refusals and plan-blocked rows.' },
          ...standardErrors,
        },
      },
    },
    '/workspaces/{organizationId}/clients/{clientId}/switch-kit/check': {
      post: {
        tags: ['Clients and domains'],
        summary: 'Check every switch for a client',
        description:
          'Re-reads DNS for up to 100 switch rows using the same concurrency limit, deadline and 30 second per-domain throttle as the single check.',
        parameters: [orgParam, idParam('clientId', 'Client identifier.')],
        responses: { 200: { description: 'Per-domain status, transition, issues and throttle state.' }, ...standardErrors },
      },
    },
    '/workspaces/{organizationId}/domains/{domainId}/switch': {
      post: {
        tags: ['Clients and domains'],
        summary: 'Start a provider switch',
        description: [
          'Plans one existing domain against its live DMARC record and creates the switch at PLANNED.',
          'Refused with NO_INCUMBENT when the record sends no reports anywhere but to us, and with SWITCH_IN_PROGRESS once the switch has moved past PLANNED.',
        ].join(' '),
        parameters: [orgParam, idParam('domainId', 'Domain identifier, id or slug.')],
        responses: { 201: { description: 'The switch and the plan that created it.' }, ...standardErrors },
      },
      get: {
        tags: ['Clients and domains'],
        summary: 'Read a domain switch',
        description: [
          'Does no DNS lookups. Without a switch row it returns the eligibility of the stored DMARC record.',
          'With a row it returns the dual and cutover records, the per-receiver overlap since dual reporting began, and cutover readiness with plain-language blockers.',
        ].join(' '),
        parameters: [orgParam, idParam('domainId', 'Domain identifier, id or slug.')],
        responses: { 200: { description: 'Switch state, records, overlap and readiness.' }, ...standardErrors },
      },
      delete: {
        tags: ['Clients and domains'],
        summary: 'Stop a provider switch',
        description: 'Deletes the switch row and records the cancellation. The domain and its reports are untouched.',
        parameters: [orgParam, idParam('domainId', 'Domain identifier, id or slug.')],
        responses: { 204: { description: 'Switch removed.' }, ...standardErrors },
      },
    },
    '/workspaces/{organizationId}/domains/{domainId}/switch/check': {
      post: {
        tags: ['Clients and domains'],
        summary: 'Check a domain switch',
        description: [
          'Re-reads the live DMARC record and external report authorisation, then moves the switch according to what DNS shows and audits a transition.',
          'A domain that is not yet verified is verified by the same check, including proof through the client report address.',
          'Returns the stored state without a DNS lookup when the last check was under 30 seconds ago.',
        ].join(' '),
        parameters: [orgParam, idParam('domainId', 'Domain identifier, id or slug.')],
        responses: { 200: { description: 'Switch state, records, overlap, readiness and verification.' }, ...standardErrors },
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
    '/workspaces/{organizationId}/domains/{domainId}/mailbox-compliance': {
      get: {
        tags: ['Scanning'],
        summary: 'Gmail, Yahoo and Outlook sender requirement checks',
        description: [
          'Reads only data already stored: the latest completed DNS scan, aggregate DMARC reports from the last 30 days, sender reviews and cached reverse-DNS intelligence. It performs no DNS lookup or network call.',
          'Reports are attributed to Google, Yahoo or Microsoft by the reporting address domain, falling back to the reporting organisation name. Any other reporter is ignored.',
          'Each check says whether the domain meets it, does not meet it, cannot have it confirmed, has not measured it, or whether it can only be checked in the provider’s own tools. No check claims compliance with a provider’s full requirements.',
          'At most 50,000 report records are read; rowsTruncated is true when the cap was reached. The daily peak ignores reports longer than 25 hours. Senders reviewed as NOT_OURS are excluded.',
          'Available on every plan. Requires domain read permission.',
        ].join(' '),
        parameters: [orgParam, idParam('domainId', 'Domain identifier, id or slug.')],
        responses: { 200: { description: 'Provider volumes, requirement checks, evidence and counts.' }, ...standardErrors },
      },
    },
    '/workspaces/{organizationId}/domains/{domainId}/scans': {
      post: {
        tags: ['Scanning'],
        summary: 'Run a scan',
        description:
          'Requires a verified domain. Stores the result and updates the domain summary. The result includes MTA-STS, TLS-RPT and BIMI checks; those fields are absent on scans stored before they existed.',
        parameters: [orgParam, idParam('domainId', 'Domain identifier.')],
        responses: { 201: { description: 'Scan completed.' }, ...standardErrors },
      },
      get: {
        tags: ['Scanning'],
        summary: 'List scans for a domain',
        description: 'Newest first. Paginated, with the trigger (manual or scheduled) and the number of DNS changes each scan recorded. Only owner, admin, analyst or viewer of this workspace.',
        parameters: [orgParam, idParam('domainId', 'Domain identifier.'), ...queryPagination],
        responses: { 200: { description: 'Scan history page.' }, ...standardErrors },
      },
    },
    '/workspaces/{organizationId}/domains/{domainId}/dns-changes': {
      get: {
        tags: ['Scanning'],
        summary: 'List DNS changes for a domain',
        description: [
          'The difference between consecutive completed scans: DMARC, SPF, DKIM and MX. Newest first, with a before and after view of only the compared values.',
          'Filter by severity with repeatable ?severity= parameters. INFO changes are history only; WARNING and CRITICAL changes are notified.',
        ].join(' '),
        parameters: [
          orgParam,
          idParam('domainId', 'Domain identifier, id or slug.'),
          ...queryPagination,
          {
            name: 'severity',
            in: 'query',
            required: false,
            description: 'Repeatable. INFO, WARNING or CRITICAL.',
            schema: { type: 'array', items: { type: 'string', enum: ['INFO', 'WARNING', 'CRITICAL'] } },
          },
        ],
        responses: { 200: { description: 'A page of DNS changes and the next cursor.' }, ...standardErrors },
      },
    },
    '/workspaces/{organizationId}/domains/{domainId}/dns-changes/{changeId}/acknowledge': {
      post: {
        tags: ['Scanning'],
        summary: 'Acknowledge a DNS change',
        description: [
          'Records that a person has seen the change. Idempotent: acknowledging an already acknowledged row returns it unchanged.',
          'A change in another workspace or on another domain is a 404. Recorded in the audit trail.',
        ].join(' '),
        parameters: [orgParam, idParam('domainId', 'Domain identifier, id or slug.'), idParam('changeId', 'DNS change identifier.')],
        responses: { 200: { description: 'The acknowledged change.' }, ...standardErrors },
      },
    },
    '/workspaces/{organizationId}/scans/{scanId}': {
      get: {
        tags: ['Scanning'],
        summary: 'Get one scan',
        description:
          'Returns the full stored scan result including the score breakdown. mtaSts, tlsRpt and bimi are optional: undefined means the scan predates those checks.',
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
          'FAILURE_COUNT and FAILURE_RATE count DMARC failures: messages where both SPF and DKIM failed alignment. A message that passes either aligned check is not a failure, because p=reject would deliver it.',
          'Existing thresholds were not changed. An open event whose condition no longer holds resolves on the next evaluation.',
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
          'Returns the exact record value for the requested policy, written to RFC 9989 (May 2026), with setup notes.',
          'pct is never generated and a pct parameter is refused with 400: RFC 9989 retired the tag, so receivers that follow it apply the whole policy whatever pct says, while older receivers apply a share.',
          'testing=true adds t=y (RFC 9989 testing mode: the policy is applied one level softer) and pct=0, which means the same to receivers still on RFC 7489. It has no effect with policy=none and is left out there.',
          'np sets the policy for subdomains that do not exist. The notes carry the stage guidance of RFC 9989 section 7.4: at least a month at none, as long again at quarantine, and DKIM on all mail before reject.',
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
            name: 'testing',
            in: 'query',
            required: false,
            description: 'Testing mode: adds t=y and pct=0 to a quarantine or reject record.',
            schema: { type: 'boolean', default: false },
          },
          {
            name: 'np',
            in: 'query',
            required: false,
            description: 'Policy for non-existent subdomains (RFC 9989 np tag).',
            schema: { type: 'string', enum: ['none', 'quarantine', 'reject'] },
          },
          {
            name: 'forensics',
            in: 'query',
            required: false,
            schema: { type: 'boolean', default: false },
          },
        ],
        responses: { 200: { description: 'Record host, value, testing and np choices, and setup notes.' }, ...standardErrors },
      },
    },
    '/workspaces/{organizationId}/domains/{domainId}/senders': {
      get: {
        tags: ['Reports'],
        summary: 'Per sending service breakdown',
        description: [
          [
    'Splits traffic by sending service, which is the source IP combined with the authenticated domain.',
    'Alignment follows RFC 7489 and honours the policy domain\'s own adkim and aspf tags, so a domain published with aspf=s gets strict SPF matching rather than relaxed.',
  ].join(' '),
          'A blended pass rate hides a rare but broken sender inside a large healthy one, so each sender is graded on its own DMARC failure share.',
          'DMARC passes when either aligned check passed, so a sender that passes DKIM but not SPF is clean here rather than failing; failedMessages and failureSharePercent retain the stricter did-not-pass-both figure.',
          'Grades are clean, degraded, failing, or insufficient-data when there are too few messages to judge.',
          'Senders first seen within the last seven days are flagged as new, which is how a spoofed source or an unexpected new service shows up.',
          'Each row carries a service name and confidence when public DNS or the report’s own auth results support one, plus the evidence behind it. A network-only ASN never produces a service name.',
          'Each row also carries the review status and owner. Review and owner decisions feed the readiness blockers and spoofing warnings.',
        ].join(' '),
        parameters: [orgParam, idParam('domainId', 'Domain identifier.')],
        responses: { 200: { description: 'Sender rows, new sender findings, and the thresholds used to grade them.' }, ...standardErrors },
      },
    },
    '/workspaces/{organizationId}/domains/{domainId}/senders/review': {
      put: {
        tags: ['Reports'],
        summary: 'Review one sender',
        description: 'APPROVED, NOT_OURS or UNREVIEWED. UNREVIEWED clears the status but keeps an owner if one is assigned. The sender must appear in this domain reports. Never plan-gated.',
        parameters: [orgParam, idParam('domainId', 'Domain identifier.')],
        responses: {
          200: { description: 'The review and owner.' },
          ...standardErrors,
        },
      },
    },
    '/workspaces/{organizationId}/domains/{domainId}/senders/owner': {
      put: {
        tags: ['Reports'],
        summary: 'Assign a sender owner',
        description: 'The owner must be a member of this workspace. Included from Fairway.',
        parameters: [orgParam, idParam('domainId', 'Domain identifier.')],
        responses: {
          200: { description: 'The review and owner.' },
          402: { description: 'Sender owners are not included in this workspace plan.' },
          ...standardErrors,
        },
      },
    },
    '/workspaces/{organizationId}/clients/{clientId}/senders/review': {
      put: {
        tags: ['Reports'],
        summary: 'Review every sender attributed to a service for a client',
        description: 'Applies to senders whose service name is confirmed or likely, at most 500 rows in one transaction, with one audit row carrying the count.',
        parameters: [orgParam, idParam('clientId', 'Client identifier.')],
        responses: { 200: { description: 'The service, status and number of senders updated.' }, ...standardErrors },
      },
    },
    '/workspaces/{organizationId}/domains/{domainId}/policy-readiness': {
      get: {
        tags: ['Onboarding and sharing'],
        summary: 'Policy readiness and blockers',
        description: [
          'Never changes anything. Reports whether tightening is safe and lists every blocker.',
          'passRatePercent is the DMARC pass rate: messages where either aligned check passed. A domain that passes DKIM and fails SPF therefore scores 100%, which is what p=reject would deliver.',
          'The DKIM pass-rate gate for reject is separate: reject requires DKIM on at least 99% of mail, because SPF alone does not survive forwarding.',
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
        description: [
          'Summary, source attribution, daily trends and spike detection across both report types.',
          'aggregate.failedMessages, trend failedMessages and source failedMessages count DMARC failures: messages where both aligned checks failed. dmarcPassRate is the share where either aligned check passed.',
          'aggregate.partiallyAlignedMessages and source partiallyAlignedMessages count messages that passed DMARC but failed one aligned check.',
        ].join(' '),
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
          'health.passRatePercent is the DMARC pass rate. Source failedMessages count DMARC failures: both aligned checks failed.',
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
      apiKeyAuth: {
        type: 'http',
        scheme: 'bearer',
        description:
          'API key issued from the workspace settings, sent as a bearer token. The key identifies the workspace, so the workspace is never taken from the path.',
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
