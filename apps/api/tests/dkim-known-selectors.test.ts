import { describe, expect, it, vi } from 'vitest';
import {
  KNOWN_SELECTOR_LIMIT,
  buildDkimProbeList,
} from '../src/scanner/dkim-discovery.js';
import { scanDomain } from '../src/scanner/scanner.js';
import type { DnsReader } from '../src/scanner/types.js';

describe('known DKIM selectors', () => {
  it('probes previously found selectors first and labels their source', () => {
    const { selected } = buildDkimProbeList(
      'v=spf1 include:_spf.google.com -all',
      ['custom', 'google'],
    );

    expect(selected[0]).toEqual({ selector: 'custom', source: 'previously found' });
    expect(selected[1]).toEqual({ selector: 'google', source: 'previously found' });
    expect(selected.filter((candidate) => candidate.selector === 'google')).toHaveLength(1);
  });

  it('never drops a known selector for the budget', () => {
    const known = ['one', 'two', 'three'];
    const { selected, skipped } = buildDkimProbeList('v=spf1 -all', known, 2);

    expect(selected.filter((candidate) => candidate.source === 'previously found').map((candidate) => candidate.selector)).toEqual(known);
    expect(selected.slice(0, known.length).map((candidate) => candidate.selector)).toEqual(known);
    // The budget is already spent, so no derived candidate is selected.
    expect(selected).toHaveLength(3);
    expect(skipped.length).toBeGreaterThan(0);
  });

  it('caps the list at ten and refuses invalid labels', () => {
    const raw = [
      'ok1',
      'ok2',
      'ok3',
      'bad label',
      'bad_label',
      '-leading',
      'trailing-',
      'ok4',
      'ok5',
      'ok6',
      'ok7',
      'ok8',
      'ok9',
      'ok10',
      'ok11',
      'ok12',
    ];
    const { selected } = buildDkimProbeList('v=spf1 -all', raw);
    const known = selected.filter((candidate) => candidate.source === 'previously found');

    expect(known).toHaveLength(KNOWN_SELECTOR_LIMIT);
    expect(known.every((candidate) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(candidate.selector))).toBe(true);
    expect(known.map((candidate) => candidate.selector)).not.toContain('bad label');
    expect(known.map((candidate) => candidate.selector)).not.toContain('bad_label');
  });

  it('still spends the remaining budget on SPF-derived candidates', () => {
    const { selected } = buildDkimProbeList('v=spf1 include:_spf.google.com -all', ['custom'], 5);
    expect(selected[0]?.selector).toBe('custom');
    expect(selected).toHaveLength(5);
    expect(selected.some((candidate) => candidate.selector === 'google')).toBe(true);
  });

  it('probes the stored selector through a real scan', async () => {
    const names: string[] = [];
    const reader: DnsReader = {
      resolveTxt: vi.fn(async (name: string) => {
        names.push(name);
        return { status: 'missing' as const };
      }),
      resolveMx: vi.fn(async () => ({ status: 'missing' as const })),
    };

    const result = await scanDomain('example.test', reader, { knownSelectors: ['custom-selector'] });

    expect(result.dkim.checkedSelectors[0]).toBe('custom-selector');
    expect(names).toContain('custom-selector._domainkey.example.test');
  });
});
