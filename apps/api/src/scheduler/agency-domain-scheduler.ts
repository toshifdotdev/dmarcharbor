import { env } from '../config/env.js';
import { withJobLease } from './job-lease.service.js';
import { recordJobFailure, recordJobSuccess } from './heartbeat.js';
import { agencyDomainMode, runAgencyDomainPass } from '../services/branding/agency-domain-hosting.service.js';

let timer: NodeJS.Timeout | undefined;
let running = false;

const CHECK_EVERY_MS = 15 * 60 * 1000;

/**
 * Takes every verified agency custom domain that is not live yet one step on:
 * reads the CNAME and the certificate, and probes `https://<domain>`. An agency
 * that published its CNAME and walked away still goes live, and so does a
 * manual one once the operator has added it to the hosting.
 *
 * Not in the heartbeat's staleness map, like the hosted DNS reconciler: it
 * only runs where the deployment has a CNAME target, so a fixed entry would
 * report it stale everywhere else.
 */
export async function runAgencyDomainCheckOnce(now: Date = new Date()): Promise<void> {
  if (agencyDomainMode() === 'unavailable' || running) {
    return;
  }

  running = true;
  try {
    const summary = await withJobLease('agency-domain-check', () => runAgencyDomainPass(now));
    if (summary !== undefined) {
      recordJobSuccess('agency-domain-check');
      if (summary.live > 0) {
        console.info(`[agency-domain] checked ${summary.checked}, now live ${summary.live}`);
      }
    }
  } catch (error) {
    console.error(`[agency-domain] check failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    recordJobFailure('agency-domain-check');
  } finally {
    running = false;
  }
}

export function startAgencyDomainScheduler(): void {
  if (timer || agencyDomainMode() === 'unavailable' || env.ALERT_SCHEDULER_DISABLED || env.NODE_ENV === 'test') {
    return;
  }

  timer = setInterval(() => {
    void runAgencyDomainCheckOnce();
  }, CHECK_EVERY_MS);
  timer.unref?.();

  console.info(`[agency-domain] check started, every 15 minutes (${agencyDomainMode()})`);
}

export function stopAgencyDomainScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
}
