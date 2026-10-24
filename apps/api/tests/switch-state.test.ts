import { describe, expect, it } from 'vitest';
import {
  nextSwitchState,
  switchObservationFromScan,
  switchIssueMessages,
  type SwitchIssueCode,
  type SwitchStateRow,
} from '../src/services/switch-kit/state.js';

const NOW = new Date('2026-10-24T12:00:00.000Z');
const OUR = 'dmarc-reports+abcdef012345@reports.dmarcharbor.com';
const DUAL = `v=DMARC1; p=none; rua=mailto:${OUR},mailto:aggregate@ag.dmarcian.com`;
const OURS_ONLY = `v=DMARC1; p=none; rua=mailto:${OUR}`;
const INCUMBENT_ONLY = 'v=DMARC1; p=none; rua=mailto:aggregate@ag.dmarcian.com';

function row(status: SwitchStateRow['status'], startedAt: Date | null = null, cutOverAt: Date | null = null): SwitchStateRow {
  return { status, startedAt, cutOverAt };
}

describe('moving a switch according to the record', () => {
  it('starts dual reporting when ours joins an incumbent', () => {
    const state = nextSwitchState(row('PLANNED'), { kind: 'found', record: DUAL }, NOW);

    expect(state.status).toBe('DUAL_REPORTING');
    expect(state.startedAt).toEqual(NOW);
    expect(state.transitioned).toBe('started');
    expect(state.issues).toEqual([]);
  });

  it('keeps dual reporting without another transition', () => {
    const startedAt = new Date('2026-10-01T00:00:00.000Z');
    const state = nextSwitchState(row('DUAL_REPORTING', startedAt), { kind: 'found', record: DUAL }, NOW);

    expect(state.status).toBe('DUAL_REPORTING');
    expect(state.startedAt).toEqual(startedAt);
    expect(state.transitioned).toBeNull();
  });

  it('cuts over when only our address remains, and can start from PLANNED', () => {
    const skipped = nextSwitchState(row('PLANNED'), { kind: 'found', record: OURS_ONLY }, NOW);
    expect(skipped.status).toBe('CUT_OVER');
    expect(skipped.cutOverAt).toEqual(NOW);
    expect(skipped.transitioned).toBe('cut_over');

    const later = new Date('2026-10-20T00:00:00.000Z');
    const finished = nextSwitchState(
      row('DUAL_REPORTING', new Date('2026-10-01T00:00:00.000Z')),
      { kind: 'found', record: OURS_ONLY },
      later,
    );
    expect(finished.status).toBe('CUT_OVER');
    expect(finished.cutOverAt).toEqual(later);
    expect(finished.startedAt).toEqual(new Date('2026-10-01T00:00:00.000Z'));
    expect(finished.transitioned).toBe('cut_over');
  });

  it('keeps CUT_OVER when nothing has changed', () => {
    const cutOverAt = new Date('2026-10-20T00:00:00.000Z');
    const state = nextSwitchState(row('CUT_OVER', null, cutOverAt), { kind: 'found', record: OURS_ONLY }, NOW);

    expect(state.status).toBe('CUT_OVER');
    expect(state.cutOverAt).toEqual(cutOverAt);
    expect(state.transitioned).toBeNull();
  });

  it('reports our address missing without moving the status', () => {
    const state = nextSwitchState(row('DUAL_REPORTING'), { kind: 'found', record: INCUMBENT_ONLY }, NOW);

    expect(state.status).toBe('DUAL_REPORTING');
    expect(state.issues).toEqual(['our_address_missing']);
    expect(state.transitioned).toBeNull();
  });

  it('keeps CUT_OVER and reports an incumbent that reappeared', () => {
    const cutOverAt = new Date('2026-10-20T00:00:00.000Z');
    const state = nextSwitchState(
      row('CUT_OVER', new Date('2026-10-01T00:00:00.000Z'), cutOverAt),
      { kind: 'found', record: DUAL },
      NOW,
    );

    expect(state.status).toBe('CUT_OVER');
    expect(state.transitioned).toBeNull();
    expect(state.issues).toContain('incumbent_reappeared');
  });

  it('reports a missing record, multiple records and a failed lookup', () => {
    expect(nextSwitchState(row('PLANNED'), { kind: 'no_record' }, NOW).issues).toEqual(['record_missing']);
    expect(nextSwitchState(row('PLANNED'), { kind: 'multiple_records' }, NOW).issues).toEqual([
      'multiple_records',
    ]);
    expect(nextSwitchState(row('PLANNED'), { kind: 'lookup_failed' }, NOW).issues).toEqual([
      'lookup_failed',
    ]);
  });

  it('judges the incumbent by the addresses planned, not by anything that is not ours', () => {
    const incumbentTargets = ['mailto:aggregate@ag.dmarcian.com'];
    const startedAt = new Date('2026-10-01T00:00:00.000Z');
    // The customer cut over and kept an email platform's address beside ours.
    const withPlatform = `v=DMARC1; p=none; rua=mailto:${OUR},mailto:dmarc@platform.example`;

    const cut = nextSwitchState(
      { status: 'DUAL_REPORTING', startedAt, cutOverAt: null, incumbentTargets },
      { kind: 'found', record: withPlatform },
      NOW,
    );
    expect(cut.status).toBe('CUT_OVER');
    expect(cut.transitioned).toBe('cut_over');

    const stillCut = nextSwitchState(
      { status: 'CUT_OVER', startedAt, cutOverAt: NOW, incumbentTargets },
      { kind: 'found', record: withPlatform },
      NOW,
    );
    expect(stillCut.issues).not.toContain('incumbent_reappeared');

    // Case and a size suffix on the incumbent's address do not hide it.
    const dual = nextSwitchState(
      { status: 'PLANNED', startedAt: null, cutOverAt: null, incumbentTargets },
      { kind: 'found', record: `v=DMARC1; p=none; rua=mailto:${OUR},MAILTO:Aggregate@AG.dmarcian.com!10m` },
      NOW,
    );
    expect(dual.status).toBe('DUAL_REPORTING');
  });

  it('reads a scan result without mistaking two joined records or a failed lookup for one record', () => {
    expect(switchObservationFromScan({ status: 'found', record: DUAL })).toEqual({ kind: 'found', record: DUAL });
    expect(switchObservationFromScan({ status: 'missing' })).toEqual({ kind: 'no_record' });
    expect(
      switchObservationFromScan({
        status: 'error',
        record: `${DUAL} | ${OURS_ONLY}`,
        notices: [{ code: 'dmarc_multiple_records' }],
      }),
    ).toEqual({ kind: 'multiple_records' });
    expect(
      switchObservationFromScan({ status: 'error', record: 'v=dmarc1; p=none', notices: [{ code: 'dmarc_version_invalid' }] }),
    ).toEqual({ kind: 'no_record' });
    expect(switchObservationFromScan({ status: 'error' })).toEqual({ kind: 'lookup_failed' });
  });

  it('has one fixed sentence for every issue code', () => {
    const codes: SwitchIssueCode[] = [
      'our_address_missing',
      'incumbent_reappeared',
      'record_missing',
      'multiple_records',
      'authorization_missing',
      'lookup_failed',
    ];

    for (const code of codes) {
      expect(switchIssueMessages[code]).toBeTruthy();
      expect(switchIssueMessages[code].length).toBeGreaterThan(10);
    }
  });
});
