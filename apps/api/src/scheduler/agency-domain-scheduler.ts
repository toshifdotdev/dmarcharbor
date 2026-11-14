import { env } from '../config/env.js';
import { withJobLease } from './job-lease.service.js';
import { recordJobFailure, recordJobSuccess } from './heartbeat.js';
import { agencyDomainMode, runAgencyDomainPass } from '../services/branding/agency-domain-hosting.service.js';
import { recheckVerifiedCustomDomains } from '../services/branding.service.js';

let timer: NodeJS.Timeout | undefined;
let running = false;

const CHECK_EVERY_MS = 15 * 60 * 1000;

/**
 * Two passes over agency custom domains.
 *
 * The first takes every verified domain that is not live yet one step on: reads
 * the CNAME and the certificate, and probes `https://<domain>`. An agency that
 * published its CNAME and walked away still goes live, and so does a manual one
 * once the operator has added it to the hosting. It runs only where the
 * deployment has a CNAME target.
 *
 * The second re-reads each verified domain's ownership TXT once a day
 * (`recheckVerifiedCustomDomains`), on every deployment, because a verified
 * domain is trusted for client sign-in and reset links whether or not this
 * deployment can host it.
 *
 * Not in the heartbeat's staleness map, like the hosted DNS reconciler.
 */
export async function runAgencyDomainCheckOnce(now: Date = new Date()): Promise<void> {
  if (running) {
    return;
  }

  running = true;
  try {
    const summary = await withJobLease('agency-domain-check', async () => {
      const hosting = agencyDomainMode() === 'unavailable' ? { checked: 0, live: 0 } : await runAgencyDomainPass(now);
      const recheck = await recheckVerifiedCustomDomains(now);
      return { hosting, recheck };
    });
    if (summary !== undefined) {
      recordJobSuccess('agency-domain-check');
      if (summary.hosting.live > 0) {
        console.info(`[agency-domain] checked ${summary.hosting.checked}, now live ${summary.hosting.live}`);
      }
      if (summary.recheck.failing > 0) {
        console.warn(
          `[agency-domain] ownership re-check: ${summary.recheck.failing} failing, ${summary.recheck.unverified} unverified`,
        );
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
  if (timer || env.ALERT_SCHEDULER_DISABLED || env.NODE_ENV === 'test') {
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
