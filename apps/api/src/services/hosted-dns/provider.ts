import { env } from '../../config/env.js';
import {
  createCloudflareClient,
  type CloudflareClient,
  type CloudflareTxtRecord,
} from '../dns-automation/cloudflare.client.js';

export interface HostedTxt {
  id: string;
  name: string;
  content: string;
  comment: string | null;
}

export interface HostedDnsProvider {
  /** HOSTED_DNS_ZONE. */
  zone: string;
  /** TXT records at exactly this name. */
  get(name: string): Promise<HostedTxt[]>;
  create(name: string, content: string, comment: string): Promise<HostedTxt>;
  update(record: HostedTxt, content: string): Promise<HostedTxt>;
  remove(recordId: string): Promise<void>;
  /** Every TXT in the zone, paginated. */
  listAll(): AsyncIterable<HostedTxt>;
}

/**
 * Cloudflare for SaaS custom hostnames, kept separate from the TXT provider.
 *
 * The two need different API permissions (SSL and Certificates versus DNS) and
 * have different failure modes, so a caller that only publishes records should
 * not have to be able to touch certificates. Custom hostnames also carry no
 * comment on non-Enterprise plans, which is why nothing here lists them: a
 * hostname can only ever be acted on through the id a row stored.
 */
export interface HostedCustomHostname {
  id: string;
  hostname: string;
  status: string | null;
  sslStatus: string | null;
  sslError: string | null;
}

export interface HostedCustomHostnameClient {
  create(hostname: string): Promise<HostedCustomHostname>;
  get(id: string): Promise<HostedCustomHostname>;
  remove(id: string): Promise<void>;
}

function toHosted(record: CloudflareTxtRecord): HostedTxt {
  return {
    id: record.id,
    name: record.name,
    content: record.content,
    comment: record.comment,
  };
}

function cloudflareHostedProvider(input: {
  zone: string;
  zoneId: string;
  client: CloudflareClient;
}): HostedDnsProvider {
  return {
    zone: input.zone,

    async get(name) {
      return (await input.client.listTxtRecords(input.zoneId, name)).map(toHosted);
    },

    async create(name, content, comment) {
      return toHosted(await input.client.createTxtRecord(input.zoneId, name, content, comment));
    },

    async update(record, content) {
      return toHosted(
        await input.client.updateTxtRecord(
          input.zoneId,
          { id: record.id, name: record.name, content: record.content, ttl: 1, comment: record.comment },
          content,
        ),
      );
    },

    async remove(recordId) {
      await input.client.deleteTxtRecord(input.zoneId, recordId);
    },

    async *listAll() {
      for (let page = 1; ; page += 1) {
        const result = await input.client.listZoneTxtRecords(input.zoneId, page);
        for (const record of result.records) {
          yield toHosted(record);
        }
        if (page >= result.totalPages) {
          return;
        }
      }
    },
  };
}

let testOverride: HostedDnsProvider | null | undefined;

/**
 * The hosted zone, or null when this deployment has not configured one.
 *
 * `testOverride === undefined` means no override; `null` means a test has
 * explicitly turned the feature off. The distinction matters because a test
 * that sets the feature off must not accidentally get the real provider back.
 */
export function hostedDnsProvider(): HostedDnsProvider | null {
  if (testOverride !== undefined) {
    return testOverride;
  }
  if (
    !env.HOSTED_DNS_ENABLED ||
    !env.HOSTED_DNS_ZONE ||
    !env.HOSTED_DNS_CLOUDFLARE_TOKEN ||
    !env.HOSTED_DNS_CLOUDFLARE_ZONE_ID
  ) {
    return null;
  }

  return cloudflareHostedProvider({
    zone: env.HOSTED_DNS_ZONE,
    zoneId: env.HOSTED_DNS_CLOUDFLARE_ZONE_ID,
    client: createCloudflareClient({ token: env.HOSTED_DNS_CLOUDFLARE_TOKEN }),
  });
}

export function setHostedDnsProviderForTests(provider: HostedDnsProvider | null): void {
  testOverride = provider;
}

/** Restores the deployment-derived provider. Test-only. */
export function resetHostedDnsProviderForTests(): void {
  testOverride = undefined;
}

let customHostnameOverride: HostedCustomHostnameClient | null | undefined;

/**
 * The custom-hostname client, or null when this deployment cannot issue
 * certificates. Same override semantics as the TXT provider: undefined means
 * "derive it", null means a test has deliberately turned it off.
 */
export function hostedCustomHostnameClient(): HostedCustomHostnameClient | null {
  if (customHostnameOverride !== undefined) {
    return customHostnameOverride;
  }
  if (
    !env.HOSTED_DNS_ENABLED ||
    !env.HOSTED_DNS_ZONE ||
    !env.HOSTED_DNS_CLOUDFLARE_TOKEN ||
    !env.HOSTED_DNS_CLOUDFLARE_ZONE_ID
  ) {
    return null;
  }

  const zoneId = env.HOSTED_DNS_CLOUDFLARE_ZONE_ID;
  const client = createCloudflareClient({ token: env.HOSTED_DNS_CLOUDFLARE_TOKEN });
  return {
    create: (hostname) => client.createCustomHostname(zoneId, hostname),
    get: (id) => client.getCustomHostname(zoneId, id),
    remove: (id) => client.deleteCustomHostname(zoneId, id),
  };
}

export function setHostedCustomHostnameClientForTests(
  client: HostedCustomHostnameClient | null,
): void {
  customHostnameOverride = client;
}

export function resetHostedCustomHostnameClientForTests(): void {
  customHostnameOverride = undefined;
}
