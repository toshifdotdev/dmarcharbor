"use client";

/**
 * first-domain.tsx — an empty workspace's first five minutes, on the
 * portfolio itself.
 *
 * An empty portfolio is not a page to explain; it is the place to start. So
 * the empty state IS the setup: name the client, type the domain, and on the
 * same screen get the two records to publish, ready to copy or email to
 * whoever holds the DNS, with the ownership check beside them. It ends with a
 * domain added and records ready to publish, and the setup page one click on.
 *
 * Beside the form, the way from here to a filled portfolio is drawn as a line:
 * the station you are at in ink, the steps ahead as a planned (dashed)
 * segment, and the portfolio as the terminus. Real steps, in the order they
 * happen; nothing on it is a figure.
 *
 * Calls, all existing API:
 *   POST /clients                         when the client is new
 *   POST /clients/:id/domains/bulk        one domain; answers with the
 *                                         ownership record, and keeps plan
 *                                         refusals apart from bad names
 *   GET  /domains/:id/onboarding          the generated DMARC record
 *   POST /domains/:id/verify              only when "Check DNS" is pressed
 *
 * The domain is cleaned the way people paste it (a URL, an email address, a
 * trailing dot) and the cleaned name is shown before it is sent.
 *
 * Test hooks kept: state-empty (both states), continue-setup,
 * ownership-record and suggested-record (through DnsHandoff). The heading
 * "Add your first client and domain" and the workspace's name are read by the
 * stranger path.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useMemo, useState, type FormEvent } from "react";
import { bulkCreateDomains, createClient, opsCall } from "@/lib/ops-client";
import { onboardingHref } from "@/lib/route-hrefs";
import type { OnboardingState } from "@/lib/types";
import { Button, ButtonLink } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { ArrowRight } from "@/components/ui/icons";
import { DnsHandoff, type PublishRecord } from "./dns-handoff";
import { OwnershipCheck } from "./ownership-check";
import { RouteList } from "./route-list";
import { SetupRail } from "./setup-rail";
import { slugFrom } from "./workspace-setup";

export function cleanDomain(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/^.*@/, "")
    // A pasted website address: mail is sent from the domain, not from www.
    .replace(/^www\./, "")
    .replace(/[/?#:].*$/, "")
    .replace(/\.+$/, "");
}

const DOMAIN = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/;

interface Added {
  id: string;
  slug: string;
  name: string;
  clientName: string;
  ownership: { host: string; value: string };
  dmarc: { host: string; value: string; notes: string[] } | null;
  dmarcFailed: boolean;
}

/** The steps from an added domain to a measured one, as stations on one line. */
const ROUTE: Array<{ name: string; kind: string }> = [
  { name: "Add the domain", kind: "A client, and the domain in the From address of its mail." },
  { name: "Publish two TXT records", kind: "One proves you manage the domain. One starts DMARC reporting with p=none, which blocks nothing." },
  { name: "Check DNS", kind: "Here or on the setup page. Waiting a while for DNS is normal." },
  { name: "Reports arrive", kind: "Usually within 24 to 48 hours of the DMARC record going live." },
  { name: "The portfolio fills in", kind: "Each domain with its posture, and the most urgent at the top." },
];

export function FirstDomain({
  organizationId,
  workspaceName,
  clients,
  limits,
}: {
  organizationId: string;
  workspaceName: string;
  clients: Array<{ id: string; name: string }>;
  /** From the plan, when it could be read: shown so a limit is known up front. */
  limits: { maxClients: number; maxActiveDomains: number; plan: string } | null;
}) {
  const router = useRouter();
  const ids = useId();
  const [clientChoice, setClientChoice] = useState<string>(clients[0]?.id ?? "new");
  const [clientName, setClientName] = useState("");
  const [rawDomain, setRawDomain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<Added | null>(null);

  const domain = useMemo(() => cleanDomain(rawDomain), [rawDomain]);
  const domainOk = DOMAIN.test(domain);
  const cleaned = rawDomain.trim() !== "" && domain !== rawDomain.trim().toLowerCase();
  const isNew = clientChoice === "new";

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || !domainOk) return;
    setBusy(true);
    setError(null);
    try {
      let clientId = clientChoice;
      let name = clients.find((c) => c.id === clientChoice)?.name ?? "";
      if (isNew) {
        name = clientName.trim();
        const base = slugFrom(name) || "client";
        let made = await createClient(organizationId, { name, slug: base });
        // A slug clash is the one refusal worth retrying on its own.
        if (!made.ok && made.status === 409) {
          made = await createClient(organizationId, { name, slug: `${base}-${Math.random().toString(36).slice(2, 6)}` });
        }
        if (!made.ok) {
          setError(made.error.message ?? "The client could not be created.");
          return;
        }
        clientId = made.data.id;
      }

      const res = await bulkCreateDomains(organizationId, clientId, [domain]);
      if (!res.ok) {
        setError(res.error.message ?? "The domain could not be added.");
        return;
      }
      const row = res.data.domains[0];
      if (!row) {
        const why = res.data.planLimitRejections[0]?.reason ?? res.data.failures[0]?.reason;
        setError(why ?? "The domain was not added.");
        return;
      }

      const ob = await opsCall<OnboardingState>(`/api/workspaces/${organizationId}/domains/${row.domainId}/onboarding`);
      setAdded({
        id: row.domainId,
        slug: row.slug,
        name: row.name,
        clientName: name,
        ownership: { host: row.verificationHost, value: row.verificationValue },
        dmarc: ob.ok ? { host: ob.data.suggestedRecord.host, value: ob.data.suggestedRecord.value, notes: ob.data.suggestedRecord.notes } : null,
        dmarcFailed: !ob.ok,
      });
    } finally {
      setBusy(false);
    }
  }

  if (added) {
    const records: PublishRecord[] = [
      {
        purpose: "Prove you manage this domain",
        host: added.ownership.host,
        value: added.ownership.value,
        note: "Only used to confirm ownership. It changes nothing about mail.",
        testId: "ownership-record",
      },
      ...(added.dmarc
        ? [
            {
              purpose: "Start receiving DMARC reports",
              host: added.dmarc.host,
              value: added.dmarc.value,
              note: "p=none only watches: no mail is blocked or quarantined. If a DMARC record already exists here, replace it rather than adding a second one: a domain can have only one.",
              testId: "suggested-record",
            },
          ]
        : []),
    ];
    return (
      <section aria-labelledby={`${ids}-done`} data-testid="state-empty" className="flex flex-col gap-10">
        <SetupRail current="records" />
        <div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="flex min-w-0 flex-col gap-7">
            <div>
              <p className="flex items-center gap-2 text-ui text-fg-2">
                <span aria-hidden className="block size-2 bg-ok" />
                <span>
                  <span className="font-semibold text-ok">Added</span> to {added.clientName}
                </span>
              </p>
              <h2 id={`${ids}-done`} className="data mt-1.5 break-all text-[26px] font-semibold leading-[32px] tracking-[-0.03em] text-fg">
                {added.name}
              </h2>
              <p className="mt-2 max-w-[64ch] text-body text-fg-2">
                Publish {records.length === 1 ? "this record" : "these two records"} wherever {added.name}&rsquo;s DNS is
                managed, or send them to whoever manages it. Then check DNS here; reports usually start within 24 to 48
                hours of the DMARC record going live.
              </p>
            </div>
            {added.dmarcFailed ? (
              <Notice tone="warn" title="The DMARC record could not be read just now">
                The domain was added. Its DMARC record is on the setup page.
              </Notice>
            ) : null}
            <DnsHandoff domain={added.name} records={records} />
          </div>

          <aside className="flex flex-col gap-6 self-start border-t border-rule pt-5 lg:border-l lg:border-t-0 lg:pl-8 lg:pt-0">
            <div>
              <p className="pb-2 text-ui font-semibold text-fg">Once it is published</p>
              <OwnershipCheck organizationId={organizationId} domainId={added.id} verified={false} refreshOnResult={false} />
            </div>
            <div className="flex flex-col gap-2 border-t border-rule pt-5">
              <ButtonLink href={onboardingHref(added.slug)} variant="primary" data-testid="continue-setup">
                Continue on the setup page
                <ArrowRight size={14} />
              </ButtonLink>
              <p className="text-meta text-fg-3">The records, every setup step and share links for this domain stay there.</p>
              <button
                type="button"
                className="link mt-2 self-start text-ui font-semibold"
                onClick={() => {
                  setAdded(null);
                  setRawDomain("");
                  setClientChoice(clients[0]?.id ?? "new");
                  router.refresh();
                }}
              >
                Done for now: show the portfolio
              </button>
            </div>
          </aside>
        </div>
      </section>
    );
  }

  return (
    <section aria-labelledby={`${ids}-head`} data-testid="state-empty" className="flex flex-col gap-10">
      <SetupRail current="domain" />
      <div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,380px)]">
        <form onSubmit={submit} className="flex max-w-[540px] flex-col gap-5">
          <div>
            <h2 id={`${ids}-head`} className="display text-[26px] leading-[30px] text-fg [text-wrap:balance]">
              {clients.length === 0 ? "Add your first client and domain" : "Add a domain to start measuring"}
            </h2>
            <p className="mt-2.5 text-body text-fg-2">
              {clients.length === 0
                ? `${workspaceName} is empty. Add your first client: a company whose mail domains you look after.`
                : `${workspaceName} has no domains yet. Pick the client a domain belongs to, or add a new one.`}{" "}
              You get the records to publish on the next screen.
            </p>
          </div>

          {clients.length > 0 ? (
            <Field label="Client">
              <Select size="lg" value={clientChoice} onChange={(e) => setClientChoice(e.target.value)} className="w-full">
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
                <option value="new">A new client…</option>
              </Select>
            </Field>
          ) : null}

          {isNew ? (
            <Field label="Client name" hint="The company, as you would name it to a colleague.">
              <Input
                size="lg"
                value={clientName}
                onChange={(e) => setClientName(e.target.value)}
                required
                minLength={2}
                maxLength={120}
                placeholder="Pellowyn Dental"
                autoFocus={clients.length === 0}
              />
            </Field>
          ) : null}

          <Field
            label="Domain"
            hint={
              <span aria-live="polite">
                {rawDomain.trim() === "" ? (
                  "The domain in the From address of their mail. A URL or an email address works too."
                ) : !domainOk ? (
                  <span className="text-warn">That does not look like a domain yet.</span>
                ) : cleaned ? (
                  <>
                    Will add <span className="data font-semibold text-fg">{domain}</span>
                  </>
                ) : (
                  "Looks right."
                )}
              </span>
            }
          >
            <Input
              size="lg"
              mono
              value={rawDomain}
              onChange={(e) => setRawDomain(e.target.value)}
              required
              inputMode="url"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="pellowyn-dental.example"
            />
          </Field>

          {error ? <Notice tone="fail" title={error} /> : null}

          <div className="flex flex-wrap items-center gap-x-5 gap-y-3 pt-1">
            <Button
              type="submit"
              variant="primary"
              size="lg"
              busy={busy}
              busyLabel="Adding the domain"
              disabled={!domainOk || (isNew && clientName.trim().length < 2)}
            >
              Add and get the records
            </Button>
            <Link href="/clients" className="link text-ui">
              Adding many? Import a list on Clients
            </Link>
          </div>
        </form>

        <aside aria-labelledby={`${ids}-route`} className="flex flex-col gap-5 self-start border-t border-rule pt-6 lg:border-t-0 lg:pt-1">
          <p id={`${ids}-route`} className="text-ui font-semibold text-fg">
            From here to a measured domain
          </p>
          {/* The first station is where the reader is; the rest is planned, the portfolio its terminus. */}
          <RouteList steps={ROUTE} here={0} />
          {limits ? (
            <p className="border-t border-rule pt-4 text-meta text-fg-3">
              The <span className="font-semibold text-fg-2">{limits.plan}</span> plan allows{" "}
              <span className="tnum">{limits.maxClients}</span> client{limits.maxClients === 1 ? "" : "s"} and{" "}
              <span className="tnum">{limits.maxActiveDomains}</span> active domain{limits.maxActiveDomains === 1 ? "" : "s"}.
            </p>
          ) : null}
        </aside>
      </div>
    </section>
  );
}

