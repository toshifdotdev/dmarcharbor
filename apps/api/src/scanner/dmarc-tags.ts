export interface DmarcRecordTags {
  tags: Record<string, string>;
  /**
   * Addresses reports are published to as mail, which we can receive.
   */
  aggregateMailtoTargets: string[];
  /**
   * URLs reports are published to over HTTP, which we cannot yet receive.
   *
   * Kept separate from the mailto targets on purpose. These are not a subset of
   * one another and collapsing them is what made a correctly configured domain
   * look like it had no reporting at all.
   */
  aggregateWebTargets: string[];
  forensicTargets: string[];
}

export function parseDmarcTags(record: string): Record<string, string> {
  return Object.fromEntries(
    record
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const separator = part.indexOf('=');
        if (separator < 1) {
          return [part.toLowerCase(), ''];
        }
        return [part.slice(0, separator).trim().toLowerCase(), part.slice(separator + 1).trim()];
      }),
  );
}

/**
 * Splits a rua/ruf value into the transports it names, rather than keeping only
 * the mailto ones.
 *
 * The previous behaviour was to filter down to mailto: and throw the rest away.
 * A record reading `rua=https://reports.example.com/v1/x` therefore looked
 * identical to a record with no rua at all, which meant we told the customer
 * their aggregate reporting was not configured and suggested they add a mailto
 * address. Their reporting was working. Following that advice repoints a correct
 * DNS record because of a gap in how we parse it.
 */
export function extractAggregateTargets(value: string | undefined): {
  mailto: string[];
  web: string[];
} {
  if (!value) {
    return { mailto: [], web: [] };
  }

  const mailto: string[] = [];
  const web: string[] = [];

  for (const raw of value.split(',')) {
    const entry = raw.trim().toLowerCase();
    if (entry.startsWith('mailto:')) {
      const address = entry.slice('mailto:'.length).split('?')[0]!.trim();
      if (address) {
        mailto.push(address);
      }
    } else if (entry.startsWith('https://')) {
      // Only https. The rua target is fetched from DNS, so allowing http would
      // mean downloading XML we have to trust over a channel anyone on the path
      // can rewrite, and an http rua is a misconfiguration worth showing.
      web.push(entry);
    }
  }

  return { mailto, web };
}

export function extractMailtoTargets(value: string | undefined): string[] {
  return extractAggregateTargets(value).mailto;
}

/**
 * Does this domain receive aggregate reports at all, by any transport?
 *
 * This is the question the scanner, readiness, portfolio and digest all need to
 * ask. Asking it three different ways is how HTTPS-only reporting came to be
 * described as absent in all three.
 */
export function hasAggregateReporting(tags: DmarcRecordTags): boolean {
  return tags.aggregateMailtoTargets.length > 0 || tags.aggregateWebTargets.length > 0;
}

/**
 * Can we actually collect them?
 *
 * Only mailto targets reach us. A web target is configured reporting we are not
 * reading, which is a different and less good state than having never set rua
 * at all, and worth distinguishing in everything that promises data.
 */
export function canCollectAggregateReports(tags: DmarcRecordTags): boolean {
  return tags.aggregateMailtoTargets.length > 0;
}

export function readDmarcRecord(record: string | null | undefined): DmarcRecordTags {
  const value = (record ?? '').trim();
  if (!value) {
    return { tags: {}, aggregateMailtoTargets: [], aggregateWebTargets: [], forensicTargets: [] };
  }

  const tags = parseDmarcTags(value);
  const aggregate = extractAggregateTargets(tags.rua);

  return {
    tags,
    aggregateMailtoTargets: aggregate.mailto,
    aggregateWebTargets: aggregate.web,
    // Forensic (ruf) reporting is only ever mailto in practice, and we can only
    // receive it by mail, so the mailto reading is the complete one here.
    forensicTargets: extractMailtoTargets(tags.ruf),
  };
}
