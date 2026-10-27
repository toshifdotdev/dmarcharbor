"use client";

/**
 * hosted-bimi.tsx — the BIMI panel on a domain's setup tab.
 *
 * BIMI is the logo beside a brand's mail in Gmail, Yahoo and Apple Mail. The
 * customer does three things once: uploads an SVG Tiny PS logo, optionally
 * uploads the certificate their authority issued, and publishes one CNAME.
 * Replacing the logo or renewing the certificate is an upload here; the DNS
 * record never changes again.
 *
 * Two rules shape this panel:
 *
 * 1. The logo is rendered only as an `<img>` from the BIMI origin, never
 *    inlined into this page. An SVG in the DOM is markup we did not write, and
 *    this page carries the session.
 * 2. The DMARC qualification is shown, never enforced. A domain at p=none can
 *    still host its logo; it simply will not be displayed by a mailbox
 *    provider until enforcement, and saying that is more useful than a button
 *    that refuses.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { instantLabel } from "@/lib/instant";
import type { HostedBimiView } from "@/lib/types";
import {
  checkHostedBimi,
  releaseHostedBimi,
  removeHostedBimiCertificate,
  startHostedBimi,
  uploadHostedBimiCertificate,
  uploadHostedBimiLogo,
} from "@/lib/ops-client";
import { Button } from "@/components/ui/button";
import { DnsRecord } from "@/components/ui/copy";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Notice } from "@/components/ui/notice";
import { UpgradeNotice } from "@/components/ui/states";

const STATUS_WORDS = {
  PENDING: "Waiting for the CNAME",
  ACTIVE: "Active",
  RELEASING: "Releasing",
  RELEASED: "Released",
} as const;

function dateLabel(value: string): string {
  return new Date(value).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function shortSha(value: string | null): string {
  return value ? value.slice(0, 12) : "none";
}

const CHANGE_WORDS: Record<string, string> = {
  created: "Hosting started",
  logo: "Logo uploaded",
  certificate: "Certificate uploaded",
  "certificate-removed": "Certificate removed",
  released: "Released",
};

export function HostedBimi({
  organizationId,
  domainId,
  domainName,
  view,
  failed,
  canEdit,
  hasFeature,
}: {
  organizationId: string;
  domainId: string;
  domainName: string;
  view: HostedBimiView | null;
  failed: boolean;
  canEdit: boolean;
  /** null when the plan could not be read. */
  hasFeature: boolean | null;
}) {
  const router = useRouter();
  const [current, setCurrent] = useState<HostedBimiView | null>(view);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorList, setErrorList] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmRelease, setConfirmRelease] = useState(false);
  const [removeNow, setRemoveNow] = useState(false);

  const hosted = current?.hosted ?? null;
  const paused = hosted?.paused ?? false;
  const certificate = hosted?.certificate ?? null;

  function sync(next: HostedBimiView): void {
    setCurrent(next);
    setError(null);
    setErrorList([]);
  }

  function failedResult(res: {
    status: number;
    error: { code?: string; message?: string; failed?: string[] };
  }): void {
    setError(res.error.message ?? "That did not go through. Nothing changed.");
    setErrorList(res.error.failed ?? []);
  }

  async function start(): Promise<void> {
    setBusy("start");
    setError(null);
    setErrorList([]);
    setNotice(null);
    const res = await startHostedBimi(organizationId, domainId);
    setBusy(null);
    if (!res.ok) {
      failedResult(res);
      return;
    }
    sync(res.data);
    setNotice(
      "Hosting started. Publish the CNAME below, then upload the SVG logo — no TXT is published until there is a logo.",
    );
    router.refresh();
  }

  async function uploadLogo(file: File | undefined): Promise<void> {
    if (!file) return;
    setBusy("logo");
    setError(null);
    setErrorList([]);
    setNotice(null);
    const res = await uploadHostedBimiLogo(organizationId, domainId, file);
    setBusy(null);
    if (!res.ok) {
      failedResult(res);
      return;
    }
    sync(res.data);
    setNotice(
      res.data.action === "unchanged"
        ? "That is the logo already published. Nothing changed."
        : "The logo is published. Mailbox providers pick it up as their caches refresh.",
    );
    router.refresh();
  }

  async function uploadCertificate(file: File | undefined): Promise<void> {
    if (!file) return;
    setBusy("certificate");
    setError(null);
    setErrorList([]);
    setNotice(null);
    const res = await uploadHostedBimiCertificate(organizationId, domainId, file);
    setBusy(null);
    if (!res.ok) {
      failedResult(res);
      return;
    }
    sync(res.data);
    setNotice(
      res.data.action === "unchanged"
        ? "That is the certificate already published. Nothing changed."
        : "The certificate is published. Gmail and Apple Mail can show the logo now.",
    );
    router.refresh();
  }

  async function removeCertificate(): Promise<void> {
    setBusy("certificate-remove");
    setError(null);
    setErrorList([]);
    setNotice(null);
    const res = await removeHostedBimiCertificate(organizationId, domainId);
    setBusy(null);
    if (!res.ok) {
      failedResult(res);
      return;
    }
    sync(res.data);
    setNotice(
      "The certificate was removed and a= is published empty. Gmail and Apple Mail stop showing the logo; other clients keep showing it.",
    );
    router.refresh();
  }

  async function check(): Promise<void> {
    setBusy("check");
    setError(null);
    setErrorList([]);
    setNotice(null);
    const res = await checkHostedBimi(organizationId, domainId);
    setBusy(null);
    if (!res.ok) {
      failedResult(res);
      return;
    }
    sync(res.data);
    setNotice(
      res.data.hosted?.status === "ACTIVE"
        ? "The CNAME points at DMARC Harbor."
        : res.data.hosted?.status === "RELEASED"
          ? "The CNAME is gone and the record is released."
          : "Checked just now. The CNAME has not been seen yet.",
    );
    router.refresh();
  }

  async function release(): Promise<void> {
    setBusy("release");
    setError(null);
    setErrorList([]);
    setNotice(null);
    const res = await releaseHostedBimi(organizationId, domainId, removeNow);
    setBusy(null);
    if (!res.ok) {
      failedResult(res);
      return;
    }
    sync(res.data);
    setConfirmRelease(false);
    setRemoveNow(false);
    setNotice(
      res.data.hosted?.status === "RELEASED"
        ? "Hosting stopped. The TXT is gone and the logo stops showing once providers refresh their cache."
        : "Release requested. We keep serving the logo until a check sees the CNAME gone.",
    );
    router.refresh();
  }

  return (
    <section aria-labelledby="hosted-bimi-head" className="flex flex-col gap-4 border-b border-rule-2 pb-6">
      <div>
        <h2 id="hosted-bimi-head" className="text-h3 font-bold tracking-[-0.01em] text-fg">
          Logo in the inbox (BIMI)
        </h2>
        {current?.available && !hosted ? (
          <p className="mt-1 max-w-[72ch] text-ui text-fg-2">
            Show your logo beside your mail in Gmail, Yahoo and Apple Mail. Upload the SVG once and publish one CNAME;
            replacing it later is another upload, never another DNS change.
          </p>
        ) : null}
      </div>

      {failed || !current ? (
        <Notice tone="warn" title="The BIMI state could not be read">
          This is not the same as it being off. Reload the page to try again.
        </Notice>
      ) : !current.available ? (
        <p className="text-ui text-fg-3" data-testid="hosted-bimi-unavailable">
          Hosted BIMI is not set up on this deployment.
        </p>
      ) : !hosted ? (
        <div className="flex flex-col gap-4">
          {current.capacity.full ? (
            <Notice tone="warn" title="Hosting is full on this deployment right now">
              Publish the BIMI record yourself. Existing hosted records keep being served.
            </Notice>
          ) : hasFeature === false ? (
            <UpgradeNotice
              feature="dns.hostedBimi"
              message="Hosting the BIMI logo is included from Harbor. Nothing about this domain changes."
              context="You can still publish default._bimi yourself with your own logo URL."
            />
          ) : canEdit ? (
            <div>
              <Button
                data-testid="hosted-bimi-start"
                variant="primary"
                busy={busy === "start"}
                busyLabel="Starting"
                onClick={start}
              >
                Host the logo with DMARC Harbor
              </Button>
            </div>
          ) : (
            <p className="text-meta text-fg-3">An owner, admin or analyst can host the logo for this domain.</p>
          )}

          <div className="flex flex-col gap-2 border-t border-rule pt-3">
            <p className="legend">What you need first</p>
            <ul className="flex flex-col gap-1.5 text-ui text-fg-2">
              <li>
                <span className="font-semibold text-fg">An SVG Tiny PS logo.</span> Square, at most 32,768 bytes,
                with <code className="data">baseProfile=&quot;tiny-ps&quot;</code>,{" "}
                <code className="data">version=&quot;1.2&quot;</code> and a title.
              </li>
              <li>
                <span className="font-semibold text-fg">DMARC at quarantine or reject.</span> BIMI logos are shown
                only for a domain under enforcement, and its organisational domain too.
              </li>
              <li>
                <span className="font-semibold text-fg">A VMC or CMC.</span> Gmail and Apple Mail show the logo only
                when a Verified Mark Certificate or Common Mark Certificate is published alongside it.
              </li>
            </ul>
          </div>

          {error ? <Notice tone="fail" title={error} /> : null}
          {errorList.length > 0 ? (
            <ul className="list-disc pl-4 text-meta text-fail" data-testid="hosted-bimi-failed">
              {errorList.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-ui">
            <span className="font-semibold text-fg" data-testid="hosted-bimi-status">
              {STATUS_WORDS[hosted.status]}
            </span>
            <span className="text-meta text-fg-3">
              {hosted.delegationCheckedAt
                ? `Last checked ${instantLabel(hosted.delegationCheckedAt)}`
                : "Not checked yet"}
            </span>
            {hosted.value ? <span className="text-meta text-fg-3">TXT published in the hosted zone.</span> : null}
          </div>

          {paused ? (
            <Notice tone="warn" title="Your plan no longer includes hosted BIMI">
              The record and its files keep being served; uploads and removals are paused. Release is still
              available.
            </Notice>
          ) : null}
          {hosted.status === "ACTIVE" && !hosted.delegated ? (
            <Notice tone="warn" title="The CNAME at default._bimi no longer points at DMARC Harbor">
              The record is still published in our zone, but nothing resolves to it, so the logo will not show. If
              the CNAME moved on purpose, release the record.
            </Notice>
          ) : null}
          {hosted.lastSyncError ? (
            <Notice tone="fail" title={`The last DNS write did not publish: ${hosted.lastSyncError}`}>
              It is retried every six hours. Nothing was lost.
            </Notice>
          ) : null}
          {notice ? <Notice tone="ok" title={notice} /> : null}
          {error ? <Notice tone="fail" title={error} /> : null}
          {errorList.length > 0 ? (
            <ul className="list-disc pl-4 text-meta text-fail" data-testid="hosted-bimi-failed">
              {errorList.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : null}

          {hosted.status === "RELEASING" && hosted.republish ? (
            <div className="flex flex-col gap-3">
              <DnsRecord
                type="TXT"
                host={hosted.republish.host}
                zone={domainName}
                value={hosted.republish.value}
                note={hosted.republish.note}
                testId="hosted-bimi-republish"
              />
              <p className="max-w-[72ch] text-ui text-fg-2">
                This value points at files we serve. To keep the logo after leaving, host the SVG and the
                certificate yourself and change the two URLs in it before the CNAME goes.
              </p>
              <div className="flex flex-wrap items-center gap-3">
                <Button data-testid="hosted-bimi-check" busy={busy === "check"} busyLabel="Checking" onClick={check}>
                  Check now
                </Button>
                {canEdit ? (
                  <Button
                    data-testid="hosted-bimi-release-now"
                    variant="ghost"
                    className="text-fail hover:text-fail"
                    busy={busy === "release"}
                    busyLabel="Removing"
                    onClick={() => {
                      setRemoveNow(true);
                      setConfirmRelease(true);
                    }}
                  >
                    Remove now
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}

          {hosted.status !== "RELEASED" ? (
            <div className="flex flex-col gap-3">
              <DnsRecord
                type="CNAME"
                host={hosted.cname.host}
                zone={domainName}
                value={hosted.cname.target}
                testId="hosted-bimi-cname"
              />
              {hosted.status === "PENDING" ? (
                <p className="max-w-[72ch] text-ui text-fg-2">
                  Publish this CNAME at your DNS host. Our zone holds the TXT it resolves to, so nothing else on
                  your side changes when the logo or certificate is replaced.
                </p>
              ) : null}
              <div className="flex flex-wrap items-center gap-3">
                <Button data-testid="hosted-bimi-check" busy={busy === "check"} busyLabel="Checking" onClick={check}>
                  Check now
                </Button>
                {canEdit ? (
                  <Button
                    data-testid="hosted-bimi-release"
                    variant="ghost"
                    className="text-fail hover:text-fail"
                    onClick={() => {
                      setRemoveNow(false);
                      setConfirmRelease(true);
                    }}
                  >
                    Stop hosting
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}

          {/* The logo. Rendered from the BIMI origin as an image, never inlined:
              an SVG in the DOM is markup this page did not write. */}
          <div className="flex flex-col gap-3 border-t border-rule pt-3">
            <p className="legend">Logo</p>
            {hosted.logo ? (
              <div className="flex flex-wrap items-center gap-4">
                <img
                  data-testid="hosted-bimi-logo"
                  src={hosted.logo.url}
                  alt={`BIMI logo for ${domainName}`}
                  width={64}
                  height={64}
                  className="size-16 shrink-0 border border-rule bg-paper-2 object-contain p-1"
                />
                <dl className="flex flex-col text-meta text-fg-2">
                  <div className="flex gap-2">
                    <dt className="text-fg-3">SHA-256</dt>
                    <dd className="data">{shortSha(hosted.logo.sha256)}</dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="text-fg-3">Size</dt>
                    <dd className="data">{hosted.logo.bytes.toLocaleString("en-GB")} bytes</dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="text-fg-3">Uploaded</dt>
                    <dd>{dateLabel(hosted.logo.uploadedAt)}</dd>
                  </div>
                </dl>
              </div>
            ) : (
              <p className="text-ui text-fg-2" data-testid="hosted-bimi-no-logo">
                No logo yet. Nothing is published until one is uploaded — a TXT pointing at a file that does not
                exist is worse than no record at all.
              </p>
            )}

            {canEdit && hosted.status !== "RELEASING" && !paused ? (
              <label className="flex flex-col gap-1 text-ui text-fg-2">
                <span className="font-semibold text-fg">{hosted.logo ? "Replace the logo" : "Upload the logo"}</span>
                <input
                  type="file"
                  accept="image/svg+xml,.svg"
                  data-testid="hosted-bimi-logo-input"
                  disabled={busy === "logo"}
                  onChange={(event) => {
                    void uploadLogo(event.target.files?.[0]);
                    event.target.value = "";
                  }}
                  className="text-meta text-fg-2 file:mr-3 file:border file:border-rule-2 file:bg-paper-2 file:px-2 file:py-1 file:text-meta file:font-semibold file:text-fg"
                />
                <span className="text-meta text-fg-3">
                  The file is stored exactly as uploaded. Do not edit it afterwards: your certificate authority
                  approved those exact bytes.
                </span>
              </label>
            ) : null}
          </div>

          {/* The certificate. */}
          <div className="flex flex-col gap-3 border-t border-rule pt-3">
            <p className="legend">Certificate</p>
            {certificate ? (
              <div className="flex flex-col gap-2">
                <dl className="flex flex-col text-meta">
                  <div className="flex justify-between gap-4 border-b border-rule py-1">
                    <dt className="text-fg-3">Type</dt>
                    <dd className="text-right font-semibold text-fg">
                      {certificate.isMarkCertificate ? "Mark certificate (VMC or CMC)" : "Not a mark certificate"}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-4 border-b border-rule py-1">
                    <dt className="text-fg-3">Issuer</dt>
                    <dd className="text-right text-fg">{certificate.issuer ?? "not stated"}</dd>
                  </div>
                  <div className="flex justify-between gap-4 border-b border-rule py-1">
                    <dt className="text-fg-3">Expires</dt>
                    <dd className={certificate.expired ? "text-right font-semibold text-fail" : "text-right text-fg"}>
                      {dateLabel(certificate.expiresAt)}
                      {certificate.expired ? " — expired" : ""}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-4 border-b border-rule py-1">
                    <dt className="text-fg-3">SHA-256</dt>
                    <dd className="data text-right">{shortSha(certificate.sha256)}</dd>
                  </div>
                </dl>
                {certificate.expired ? (
                  <Notice tone="fail" title="This certificate has expired">
                    We publish a= empty, so Gmail and Apple Mail stop showing the logo. Upload the renewed
                    certificate your authority issued.
                  </Notice>
                ) : certificate.expiresSoon ? (
                  <Notice tone="warn" title={`This certificate expires on ${dateLabel(certificate.expiresAt)}`}>
                    Renew it with your certificate authority and upload the new file before then. When it expires we
                    publish a= empty and the logo stops showing in Gmail and Apple Mail.
                  </Notice>
                ) : null}
                {!certificate.isMarkCertificate ? (
                  <p className="text-meta text-fg-3">
                    Without the mark certificate extended key usage, Gmail and Apple Mail will not show this logo.
                  </p>
                ) : null}
                {canEdit && hosted.status !== "RELEASING" && !paused ? (
                  <div>
                    <Button
                      data-testid="hosted-bimi-certificate-remove"
                      variant="ghost"
                      className="text-fail hover:text-fail"
                      busy={busy === "certificate-remove"}
                      busyLabel="Removing"
                      onClick={removeCertificate}
                    >
                      Remove the certificate
                    </Button>
                  </div>
                ) : null}
              </div>
            ) : (
              <p className="text-ui text-fg-2">
                No certificate. The record publishes <code className="data">a=</code> empty, so clients that do not
                require one still show the logo; Gmail and Apple Mail do not.
              </p>
            )}

            {canEdit && hosted.status !== "RELEASING" && !paused ? (
              <label className="flex flex-col gap-1 text-ui text-fg-2">
                <span className="font-semibold text-fg">
                  {certificate ? "Replace the certificate" : "Upload the certificate"}
                </span>
                <input
                  type="file"
                  accept="application/x-pem-file,application/pem-certificate-chain,text/plain,.pem,.crt,.cer"
                  data-testid="hosted-bimi-certificate-input"
                  disabled={busy === "certificate"}
                  onChange={(event) => {
                    void uploadCertificate(event.target.files?.[0]);
                    event.target.value = "";
                  }}
                  className="text-meta text-fg-2 file:mr-3 file:border file:border-rule-2 file:bg-paper-2 file:px-2 file:py-1 file:text-meta file:font-semibold file:text-fg"
                />
                <span className="text-meta text-fg-3">
                  The .pem file your certificate authority sent. Never the private key.
                </span>
              </label>
            ) : null}

            <p className="max-w-[72ch] text-meta text-fg-3">
              DMARC Harbor does not check that the logo matches the one in the certificate. Upload the exact SVG your
              certificate authority approved.
            </p>
          </div>

          {/* The DMARC answer, from the latest scan. Never a blocker. */}
          <div className="flex flex-col gap-2 border-t border-rule pt-3">
            <p className="legend">DMARC for BIMI</p>
            {hosted.dmarc === null ? (
              <p className="text-ui text-fg-3">
                No completed scan yet. Scan the domain to see whether its DMARC policy allows a logo.
              </p>
            ) : hosted.dmarc.qualifies ? (
              <p className="text-ui text-fg-2" data-testid="hosted-bimi-dmarc">
                <span className="font-semibold text-ok">Qualifies.</span> The DMARC policy found by the latest scan is
                at enforcement.
                {hosted.dmarc.reasons.length > 0 ? ` ${hosted.dmarc.reasons.join(" ")}` : ""}
              </p>
            ) : (
              <div data-testid="hosted-bimi-dmarc" className="flex flex-col gap-1">
                <p className="text-ui text-fg-2">
                  <span className="font-semibold text-warn">Not yet.</span> The logo is hosted and published, but a
                  mailbox provider will not show it until DMARC is at quarantine or reject.
                </p>
                <ul className="list-disc pl-4 text-meta text-fg-3">
                  {hosted.dmarc.reasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {hosted.status === "RELEASED" ? (
            <div className="flex flex-col gap-3">
              <p className="text-ui text-fg-2">
                This domain no longer publishes its BIMI record from DMARC Harbor. The TXT is gone and the files are
                retired.
              </p>
              {canEdit && hasFeature !== false && !current.capacity.full ? (
                <div>
                  <Button
                    data-testid="hosted-bimi-start"
                    busy={busy === "start"}
                    busyLabel="Starting"
                    onClick={start}
                  >
                    Host the logo again
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}

          {hosted.changes.length > 0 ? (
            <div className="flex flex-col gap-2 border-t border-rule pt-3">
              <p className="legend">History</p>
              <ul className="flex flex-col">
                {hosted.changes.map((change) => (
                  <li
                    key={change.id}
                    className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-rule py-2 text-meta"
                  >
                    <span className="font-semibold text-fg">
                      {CHANGE_WORDS[change.reason] ?? change.reason}
                    </span>
                    <span className="text-fg-3">{instantLabel(change.createdAt)}</span>
                    <span className="text-fg-3">{change.actor?.name ?? "system"}</span>
                    {change.previousLogoSha || change.newLogoSha ? (
                      <span className="data text-fg-3">
                        logo {shortSha(change.previousLogoSha)} → {shortSha(change.newLogoSha)}
                      </span>
                    ) : null}
                    {change.previousCertSha || change.newCertSha ? (
                      <span className="data text-fg-3">
                        certificate {shortSha(change.previousCertSha)} → {shortSha(change.newCertSha)}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      )}

      <ConfirmDialog
        open={confirmRelease}
        onClose={() => {
          setConfirmRelease(false);
          setRemoveNow(false);
        }}
        onConfirm={release}
        title="Stop hosting this BIMI record?"
        body={
          <div className="flex flex-col gap-3">
            <p>
              Removing BIMI never affects mail delivery — only the logo. The DMARC record is separate and is not
              touched.
            </p>
            {hosted?.status === "PENDING" || hosted?.status === "RELEASING" ? (
              <p>The record is removed at once; nothing was delegated that we still need to serve.</p>
            ) : (
              <p>
                We keep serving the logo until a check sees the CNAME gone, so the logo does not vanish mid-fetch.
              </p>
            )}
            <label className="flex items-baseline gap-2 text-ui text-fg-2">
              <input
                type="checkbox"
                data-testid="hosted-bimi-remove-now"
                checked={removeNow}
                onChange={(event) => setRemoveNow(event.target.checked)}
              />
              Remove the record now instead of waiting for the CNAME check.
            </label>
          </div>
        }
        confirmLabel="Stop hosting"
        busy={busy === "release"}
        danger
        error={error}
        testId="hosted-bimi-release"
      />
    </section>
  );
}
