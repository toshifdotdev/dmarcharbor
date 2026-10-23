"use client";

/**
 * client-forms.tsx — adding a client, and adding its domains.
 *
 *   AddClient   name and slug (the slug follows the name until edited). The
 *               new client becomes the target of the domain form at once, so
 *               "create a client, then give it a domain" is two fields and two
 *               presses, with no picking from a list in between.
 *   AddDomains  one domain, or a pasted list. Domains are cleaned the way
 *               people paste them (URLs, email addresses, www., a trailing
 *               dot) and the cleaned names are shown before anything is sent.
 *               A list comes back as three separate verdicts, never one "some
 *               failed": created, refused (with the API's reason), and
 *               blocked by the plan. The ownership records the import returns
 *               are handed straight back, ready to copy or email to whoever
 *               runs the client's DNS.
 *
 * Test hooks kept: client-name, client-slug, create-client, domain-name,
 * add-domain, continue-setup, single-mode, bulk-mode, bulk-domain-input,
 * bulk-result.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { forwardRef, useId, useMemo, useState, type FormEvent } from "react";
import { clsx } from "clsx";
import { bulkCreateDomains, createClient, createDomain, type BulkDomainResult } from "@/lib/ops-client";
import { onboardingHref } from "@/lib/route-hrefs";
import { Button, ButtonLink } from "@/components/ui/button";
import { Textarea } from "@/components/ui/choice";
import { CopyButton } from "@/components/ui/copy";
import { Field, Input, Select } from "@/components/ui/field";
import { ArrowRight } from "@/components/ui/icons";
import { Notice } from "@/components/ui/notice";
import { zoneLines } from "./dns-handoff";
import { cleanDomain } from "./first-domain";
import { ActionRefusal, type ActionError } from "./plan-refusal";

const DOMAIN = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/* ─── a client ─────────────────────────────────────────────────────────── */

export function AddClient({
  organizationId,
  atLimit,
  limitLine,
  onCreated,
}: {
  organizationId: string;
  /** The plan's client limit is reached: the form explains rather than fails. */
  atLimit: boolean;
  limitLine: string | null;
  onCreated: (client: { id: string; name: string; slug: string }) => void;
}) {
  const router = useRouter();
  const id = useId();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ActionError | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const effectiveSlug = slugEdited ? slug : slugify(name);
  const slugOk = SLUG.test(effectiveSlug) && effectiveSlug.length >= 2;
  const nameOk = name.trim().length >= 2;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || !nameOk || !slugOk) return;
    setBusy(true);
    setError(null);
    setDone(null);
    const res = await createClient(organizationId, { name: name.trim(), slug: effectiveSlug });
    setBusy(false);
    if (!res.ok) {
      setError(
        res.status === 409
          ? { ...res.error, message: `${res.error.message ?? "That slug is taken."} Change the slug and try again.` }
          : res.error,
      );
      return;
    }
    setDone(res.data.name);
    onCreated(res.data);
    setName("");
    setSlug("");
    setSlugEdited(false);
    router.refresh();
  }

  return (
    <section aria-labelledby={`${id}-head`} className="flex flex-col gap-3">
      <h2 id={`${id}-head`} className="text-h3 font-bold tracking-[-0.01em] text-fg">
        Add a client
      </h2>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <Field label="Client name" hint="The company, as you would name it to a colleague.">
          <Input
            size="lg"
            value={name}
            onChange={(e) => setName(e.target.value)}
            minLength={2}
            maxLength={100}
            required
            placeholder="Example Freight"
            data-testid="client-name"
            disabled={atLimit}
          />
        </Field>
        <Field
          label="Slug"
          hint={slugEdited ? "Lowercase letters, digits and single hyphens." : "Follows the name until you change it. Used in links."}
          error={effectiveSlug && !slugOk ? "Use lowercase letters, digits and single hyphens." : undefined}
        >
          <Input
            mono
            value={effectiveSlug}
            onChange={(e) => {
              setSlugEdited(true);
              setSlug(e.target.value.toLowerCase());
            }}
            maxLength={60}
            pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
            spellCheck={false}
            autoCapitalize="none"
            data-testid="client-slug"
            disabled={atLimit}
          />
        </Field>
        {atLimit ? (
          <Notice
            tone="warn"
            title="The plan's client limit is reached"
            action={
              <ButtonLink href="/billing" size="sm">
                See plan options
              </ButtonLink>
            }
          >
            {limitLine}
          </Notice>
        ) : null}
        <ActionRefusal error={error} />
        {done ? (
          <p role="status" className="text-ui font-semibold text-ok [animation:hb-rise_200ms_ease-out]">
            {done} added. Its domains go in below.
          </p>
        ) : null}
        <Button
          type="submit"
          variant="primary"
          busy={busy}
          busyLabel="Creating the client"
          disabled={atLimit || !nameOk || !slugOk}
          data-testid="create-client"
          className="self-start"
        >
          Create client
        </Button>
      </form>
    </section>
  );
}

/* ─── its domains ──────────────────────────────────────────────────────── */

function parseList(raw: string): { names: string[]; invalid: string[]; duplicates: number } {
  const seen = new Set<string>();
  const names: string[] = [];
  const invalid: string[] = [];
  let duplicates = 0;
  for (const part of raw.split(/[\r\n,;\s]+/)) {
    if (!part.trim()) continue;
    const name = cleanDomain(part);
    if (!name) continue;
    if (seen.has(name)) {
      duplicates++;
      continue;
    }
    seen.add(name);
    (DOMAIN.test(name) ? names : invalid).push(name);
  }
  return { names, invalid, duplicates };
}

type Outcome =
  | { kind: "single"; clientName: string; name: string; slug: string }
  | { kind: "bulk"; clientName: string; result: BulkDomainResult };

export const AddDomains = forwardRef<
  HTMLInputElement,
  {
    organizationId: string;
    clients: Array<{ id: string; name: string }>;
    target: string;
    onTarget: (id: string) => void;
  }
>(function AddDomains({ organizationId, clients, target, onTarget }, inputRef) {
  const router = useRouter();
  const id = useId();
  const [mode, setMode] = useState<"single" | "bulk">("single");
  const [single, setSingle] = useState("");
  const [list, setList] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ActionError | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const cleaned = cleanDomain(single);
  const singleOk = DOMAIN.test(cleaned);
  const parsed = useMemo(() => parseList(list), [list]);
  const targetName = clients.find((c) => c.id === target)?.name ?? "";

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!target) {
      setError({ message: "Choose which client these domains belong to." });
      return;
    }
    setBusy(true);
    setError(null);
    setOutcome(null);
    if (mode === "single") {
      const res = await createDomain(organizationId, target, { name: cleaned });
      setBusy(false);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setOutcome({ kind: "single", clientName: targetName, name: res.data.name, slug: res.data.slug });
      setSingle("");
    } else {
      const res = await bulkCreateDomains(organizationId, target, parsed.names);
      setBusy(false);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setOutcome({ kind: "bulk", clientName: targetName, result: res.data });
      if (res.data.failed === 0 && res.data.planBlocked === 0) setList("");
    }
    router.refresh();
  }

  if (clients.length === 0) {
    return (
      <section className="flex flex-col gap-2">
        <h2 className="text-h3 font-bold tracking-[-0.01em] text-fg">Add domains</h2>
        <p className="text-ui text-fg-3">Domains live inside a client. Add the client first, above.</p>
      </section>
    );
  }

  return (
    <section aria-labelledby={`${id}-head`} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={`${id}-head`} className="text-h3 font-bold tracking-[-0.01em] text-fg">
          Add domains
        </h2>
        <fieldset className="inline-flex rounded-ctl border border-rule-2 bg-paper-3 p-[2px]">
          <legend className="sr-only">How many domains</legend>
          {(
            [
              ["single", "One", "single-mode"],
              ["bulk", "A list", "bulk-mode"],
            ] as const
          ).map(([value, label, testId]) => (
            <label
              key={value}
              data-testid={testId}
              className={clsx(
                "inline-flex h-6 cursor-pointer items-center rounded-[2px] px-2.5 text-meta font-semibold",
                "has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-act",
                mode === value ? "bg-paper-2 text-fg shadow-[0_0_0_1px_var(--color-rule-2)]" : "text-fg-3 hover:text-fg",
              )}
            >
              <input
                type="radio"
                name={`${id}-mode`}
                className="sr-only"
                checked={mode === value}
                onChange={() => {
                  setMode(value);
                  setOutcome(null);
                  setError(null);
                }}
              />
              {label}
            </label>
          ))}
        </fieldset>
      </div>

      <form onSubmit={submit} className="flex flex-col gap-3">
        <Field label="Client">
          <Select size="lg" value={target} onChange={(e) => onTarget(e.target.value)} className="w-full">
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>

        {mode === "single" ? (
          <Field
            label="Domain"
            hint={
              single.trim() === "" ? (
                "The domain in the From address of their mail. A URL or an email address works too."
              ) : !singleOk ? (
                <span className="text-warn">That does not look like a domain yet.</span>
              ) : cleaned !== single.trim().toLowerCase() ? (
                <>
                  Will add <span className="data font-semibold text-fg">{cleaned}</span>
                </>
              ) : (
                "Looks right."
              )
            }
          >
            <Input
              ref={inputRef}
              size="lg"
              mono
              value={single}
              onChange={(e) => setSingle(e.target.value)}
              inputMode="url"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="client.example"
              data-testid="domain-name"
            />
          </Field>
        ) : (
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${id}-list`} className="text-meta font-semibold text-fg-2">
              Domains, one per line
            </label>
            <Textarea
              id={`${id}-list`}
              mono
              rows={7}
              value={list}
              onChange={(e) => setList(e.target.value)}
              spellCheck={false}
              placeholder={"client.example\nmail.client.example\nclient-brand.example"}
              data-testid="bulk-domain-input"
            />
            <p className="text-meta text-fg-3" aria-live="polite">
              {list.trim() === "" ? (
                "Commas and spaces work too. Duplicates and blank lines are skipped; each domain needs its own records afterwards."
              ) : (
                <>
                  <span className="tnum font-semibold text-fg">{parsed.names.length}</span> to add
                  {parsed.duplicates > 0 ? `, ${parsed.duplicates} duplicate${parsed.duplicates === 1 ? "" : "s"} skipped` : ""}
                  {parsed.invalid.length > 0 ? (
                    <span className="text-warn">
                      , {parsed.invalid.length} not a domain: <span className="data">{parsed.invalid.slice(0, 3).join(", ")}</span>
                      {parsed.invalid.length > 3 ? "…" : ""}
                    </span>
                  ) : null}
                  .
                </>
              )}
            </p>
          </div>
        )}

        <ActionRefusal error={error} />

        <Button
          type="submit"
          variant="primary"
          busy={busy}
          busyLabel={mode === "single" ? "Adding the domain" : `Adding ${parsed.names.length} domains`}
          disabled={mode === "single" ? !singleOk : parsed.names.length === 0}
          data-testid="add-domain"
          className="self-start"
        >
          {mode === "single"
            ? "Add domain"
            : parsed.names.length === 0
              ? "Add domains"
              : `Add ${parsed.names.length} domain${parsed.names.length === 1 ? "" : "s"}`}
        </Button>
      </form>

      {outcome?.kind === "single" ? (
        <div role="status" className="flex flex-col gap-2 border-t border-rule pt-3 [animation:hb-rise_220ms_ease-out]">
          <p className="text-ui text-fg-2">
            <span className="font-semibold text-ok">Added</span>{" "}
            <span className="data font-semibold text-fg">{outcome.name}</span> to {outcome.clientName}. Its two records
            are on the setup page.
          </p>
          <ButtonLink href={onboardingHref(outcome.slug)} variant="secondary" data-testid="continue-setup" className="self-start">
            Continue setup
            <ArrowRight size={14} />
          </ButtonLink>
        </div>
      ) : null}

      {outcome?.kind === "bulk" ? <BulkResult clientName={outcome.clientName} result={outcome.result} /> : null}
    </section>
  );
});

function BulkResult({ clientName, result }: { clientName: string; result: BulkDomainResult }) {
  const records = result.domains.map((d) => ({ purpose: d.name, host: d.verificationHost, value: d.verificationValue }));
  const zone = zoneLines(records);
  const body = [
    "Hello,",
    "",
    `Please publish these ownership TXT records for ${clientName}. They prove the domains are managed by us and do not change how mail is delivered.`,
    "",
    ...result.domains.flatMap((d) => [`${d.name}`, `   Host:  ${d.verificationHost}`, `   Value: ${d.verificationValue}`, ""]),
    "Each domain also needs a DMARC record; we will send those separately.",
    "",
    "Thank you.",
  ].join("\n");
  const mailto = `mailto:?subject=${encodeURIComponent(`Ownership records for ${clientName}`)}&body=${encodeURIComponent(body)}`;

  return (
    <div role="status" data-testid="bulk-result" className="flex flex-col gap-3 border-t border-rule pt-3 [animation:hb-rise_220ms_ease-out]">
      <p className="text-ui text-fg-2">
        <span className="tnum font-semibold text-ok">{result.created}</span> added to {clientName}
        {result.failed > 0 ? (
          <>
            , <span className="tnum font-semibold text-fail">{result.failed}</span> refused
          </>
        ) : null}
        {result.planBlocked > 0 ? (
          <>
            , <span className="tnum font-semibold text-warn">{result.planBlocked}</span> over the plan&rsquo;s limit of{" "}
            <span className="tnum">{result.limits.maxDomains}</span>
          </>
        ) : null}
        .
      </p>

      {result.domains.length > 0 ? (
        <>
          <ul className="flex max-h-[220px] flex-col overflow-y-auto border-y border-rule">
            {result.domains.map((d) => (
              <li key={d.domainId} className="flex items-baseline justify-between gap-3 border-b border-rule py-1.5 last:border-b-0">
                <span className="data min-w-0 truncate text-meta text-fg">{d.name}</span>
                <Link href={onboardingHref(d.slug)} className="link shrink-0 text-meta font-semibold" data-testid={result.domains.length === 1 ? "continue-setup" : undefined}>
                  Setup
                </Link>
              </li>
            ))}
          </ul>
          <div data-copy-scope className="flex flex-col gap-1.5">
            <p className="text-meta text-fg-2">
              Ownership records for the new domains, for whoever runs the DNS. DMARC records are on each setup page.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <CopyButton value={zone} label="Copy the ownership records as zone file lines" />
              <a href={mailto} className="link text-meta font-semibold">
                Email them
              </a>
            </div>
            <pre data-copy-value className="sr-only">
              {zone}
            </pre>
          </div>
        </>
      ) : null}

      {result.failures.length > 0 ? (
        <div>
          <p className="legend pb-1">Refused</p>
          <ul className="flex flex-col gap-1 text-meta">
            {result.failures.map((f) => (
              <li key={`${f.index}-${f.name}`}>
                <span className="data font-semibold text-fg">{f.name}</span> <span className="text-fg-3">{f.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {result.planLimitRejections.length > 0 ? (
        <Notice
          tone="warn"
          title={`${result.planLimitRejections.length} not added: the plan allows ${result.limits.maxDomains} active domains`}
          action={
            <ButtonLink href="/billing" size="sm">
              See plan options
            </ButtonLink>
          }
        >
          <span className="data">{result.planLimitRejections.map((f) => f.name).join(", ")}</span>
        </Notice>
      ) : null}
    </div>
  );
}
