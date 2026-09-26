export interface DmarcRecordTags {
  tags: Record<string, string>;
  aggregateTargets: string[];
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

export function extractMailtoTargets(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.startsWith('mailto:'))
    .map((entry) => entry.slice('mailto:'.length).split('?')[0].trim())
    .filter(Boolean);
}

export function readDmarcRecord(record: string | null | undefined): DmarcRecordTags {
  const value = (record ?? '').trim();
  if (!value) {
    return { tags: {}, aggregateTargets: [], forensicTargets: [] };
  }

  const tags = parseDmarcTags(value);
  return {
    tags,
    aggregateTargets: extractMailtoTargets(tags.rua),
    forensicTargets: extractMailtoTargets(tags.ruf),
  };
}
