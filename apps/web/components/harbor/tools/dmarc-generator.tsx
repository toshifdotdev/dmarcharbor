"use client";

/**
 * dmarc-generator.tsx — /tools/dmarc-generator: write a DMARC record to
 * publish. Runs in the browser alone: nothing is sent anywhere.
 *
 * The record is built from the choices as they change, tags in the order an
 * operator reads them, defaults left out (relaxed alignment, sp following p,
 * fo=0). pct is not offered: RFC 9989 retired it, and newer receivers ignore
 * it and apply p to all failing mail. Beside the form, the record as it will
 * be published, the policy line, and what each tag will make a receiver do,
 * in the same words the DMARC lookup uses (record-reading.tsx TAGS).
 *
 * Test hooks: gen-domain, gen-rua, gen-ruf, gen-sp, gen-fo, gen-testing,
 * gen-record (the TXT record), gen-warnings.
 */

import { useMemo, useState } from "react";
import { Checkbox } from "@/components/ui/choice";
import { DnsRecord } from "@/components/ui/copy";
import { Field, Input, Segmented, Select } from "@/components/ui/field";
import { TAGS, parseTags, type Tone } from "../record-reading";
import { PolicyLine, StationList } from "./figures";
import { FigureHead } from "./lookup-line";
import { lookupDomain } from "./scan";

type Policy = "none" | "quarantine" | "reject";
type Align = "r" | "s";

const EMAIL = /^[^\s@,;]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

const TONE_TEXT: Record<Tone, string> = {
  ok: "text-ok",
  warn: "text-warn",
  fail: "text-fail",
  void: "text-fg-4",
  plain: "text-fg-2",
};

function addresses(raw: string): { valid: string[]; invalid: string[] } {
  const parts = raw
    .split(/[\s,;]+/)
    .map((p) => p.trim().replace(/^mailto:/i, ""))
    .filter(Boolean);
  const unique = [...new Set(parts.map((p) => p.toLowerCase()))];
  return { valid: unique.filter((p) => EMAIL.test(p)), invalid: unique.filter((p) => !EMAIL.test(p)) };
}

export function buildDmarcRecord(input: {
  policy: Policy;
  sp: Policy | "";
  testing: boolean;
  rua: string[];
  ruf: string[];
  fo: string;
  adkim: Align;
  aspf: Align;
}): string {
  const tags = [`v=DMARC1`, `p=${input.policy}`];
  if (input.sp) tags.push(`sp=${input.sp}`);
  if (input.testing && input.policy !== "none") tags.push("t=y");
  if (input.rua.length) tags.push(`rua=${input.rua.map((a) => `mailto:${a}`).join(",")}`);
  if (input.ruf.length) {
    tags.push(`ruf=${input.ruf.map((a) => `mailto:${a}`).join(",")}`);
    if (input.fo && input.fo !== "0") tags.push(`fo=${input.fo}`);
  }
  if (input.adkim === "s") tags.push("adkim=s");
  if (input.aspf === "s") tags.push("aspf=s");
  return tags.join("; ");
}

export function DmarcGenerator() {
  const [domainRaw, setDomainRaw] = useState("");
  const [policy, setPolicy] = useState<Policy>("none");
  const [sp, setSp] = useState<Policy | "">("");
  const [testing, setTesting] = useState(false);
  const [ruaRaw, setRuaRaw] = useState("");
  const [rufRaw, setRufRaw] = useState("");
  const [fo, setFo] = useState("0");
  const [adkim, setAdkim] = useState<Align>("r");
  const [aspf, setAspf] = useState<Align>("r");

  const domain = lookupDomain(domainRaw);
  const rua = useMemo(() => addresses(ruaRaw), [ruaRaw]);
  const ruf = useMemo(() => addresses(rufRaw), [rufRaw]);
  const record = buildDmarcRecord({ policy, sp, testing, rua: rua.valid, ruf: ruf.valid, fo, adkim, aspf });
  const tags = parseTags(record.replace(/;\s*/g, ";"));
  const zone = domain || "yourclient.example";

  // Report addresses at another domain need that domain's permission: a TXT
  // record at <zone>._report._dmarc.<their domain> (external report
  // destination verification).
  const outside = domain ? [...rua.valid, ...ruf.valid].map((a) => a.split("@")[1]!).filter((d) => d !== domain && !d.endsWith(`.${domain}`)) : [];

  const warnings: string[] = [];
  if (rua.valid.length === 0) warnings.push("No report address: nobody will receive this domain's reports, so nobody can see who sends as it.");
  if (policy !== "none" && rua.valid.length === 0)
    warnings.push(`p=${policy} with no reports enforces blind: a service you forgot will start failing and nobody will see why.`);
  if (policy === "reject" && !testing)
    warnings.push("p=reject refuses failing mail outright. Move to it only after the reports show every real sender passing.");
  if (adkim === "s" || aspf === "s")
    warnings.push("Strict alignment fails mail signed or sent from a subdomain (mail.yourclient.example). Most domains keep relaxed.");
  if (rua.invalid.length || ruf.invalid.length)
    warnings.push(`Not an email address, left out: ${[...rua.invalid, ...ruf.invalid].join(", ")}.`);

  return (
    <div className="grid gap-x-16 gap-y-14 min-[68.75rem]:grid-cols-[minmax(0,0.85fr)_minmax(0,1fr)]">
      <form className="flex min-w-0 flex-col gap-7" onSubmit={(e) => e.preventDefault()} aria-label="DMARC record choices">
        <Field label="Domain" hint="Optional. Fills in the host name; nothing is looked up.">
          <Input
            mono
            size="lg"
            value={domainRaw}
            onChange={(e) => setDomainRaw(e.target.value)}
            placeholder="yourclient.example"
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="none"
            data-testid="gen-domain"
          />
        </Field>

        <div className="flex flex-col gap-2">
          <p className="text-[14px] font-semibold text-fg">Policy for mail that fails</p>
          <div className="flex">
            <Segmented<Policy>
              label="Policy"
              value={policy}
              onChange={setPolicy}
              options={[
                { value: "none", label: "None: watch" },
                { value: "quarantine", label: "Quarantine" },
                { value: "reject", label: "Reject" },
              ]}
            />
          </div>
          <p className="text-[13.5px] leading-[1.45] text-fg-4">
            Start at none with a report address, read the reports, then move up once every real sender passes.
          </p>
        </div>

        <Field label="Aggregate reports to" hint="One or more addresses, separated by commas. Receivers send a daily summary here.">
          <Input
            mono
            size="lg"
            value={ruaRaw}
            onChange={(e) => setRuaRaw(e.target.value)}
            placeholder="dmarc-reports@yourclient.example"
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="none"
            data-testid="gen-rua"
          />
        </Field>

        <Field label="Subdomains">
          <Select value={sp} onChange={(e) => setSp(e.target.value as Policy | "")} data-testid="gen-sp" size="lg" className="w-full max-w-[320px]">
            <option value="">The same policy (sp not set)</option>
            <option value="none">none: watch only</option>
            <option value="quarantine">quarantine: to spam</option>
            <option value="reject">reject: refused</option>
          </Select>
        </Field>

        <div className="flex flex-wrap gap-x-10 gap-y-5">
          <div className="flex flex-col gap-2">
            <p className="text-[14px] font-semibold text-fg">DKIM alignment</p>
            <div className="flex"><Segmented<Align> label="DKIM alignment" value={adkim} onChange={setAdkim} options={[{ value: "r", label: "Relaxed" }, { value: "s", label: "Strict" }]} /></div>
          </div>
          <div className="flex flex-col gap-2">
            <p className="text-[14px] font-semibold text-fg">SPF alignment</p>
            <div className="flex"><Segmented<Align> label="SPF alignment" value={aspf} onChange={setAspf} options={[{ value: "r", label: "Relaxed" }, { value: "s", label: "Strict" }]} /></div>
          </div>
        </div>

        <Checkbox
          label="Testing mode (t=y)"
          hint={
            policy === "none"
              ? "Only applies to quarantine or reject."
              : "Receivers treat failing mail one step softer while you check the move: quarantine as none, reject as quarantine."
          }
          checked={testing && policy !== "none"}
          disabled={policy === "none"}
          onChange={(e) => setTesting(e.target.checked)}
          data-testid="gen-testing"
        />

        <details className="group border-t border-rule pt-4">
          <summary className="cursor-pointer text-[14.5px] font-semibold text-fg marker:text-fg-4">Failure samples (optional)</summary>
          <div className="mt-4 flex flex-col gap-5">
            <Field
              label="Failure samples to"
              hint="Per-message samples of failing mail. Few receivers send them, and they can hold personal data."
            >
              <Input
                mono
                size="lg"
                value={rufRaw}
                onChange={(e) => setRufRaw(e.target.value)}
                placeholder="dmarc-failures@yourclient.example"
                spellCheck={false}
                autoComplete="off"
                autoCapitalize="none"
                data-testid="gen-ruf"
              />
            </Field>
            <Field label="Send a sample when">
              <Select value={fo} onChange={(e) => setFo(e.target.value)} disabled={ruf.valid.length === 0} data-testid="gen-fo" size="lg" className="w-full max-w-[320px]">
                <option value="0">every check fails (fo=0, the default)</option>
                <option value="1">any check fails (fo=1)</option>
                <option value="d">DKIM fails (fo=d)</option>
                <option value="s">SPF fails (fo=s)</option>
              </Select>
            </Field>
          </div>
        </details>
      </form>

      <div className="flex min-w-0 flex-col gap-12">
        <div>
          <FigureHead name="The record to publish" meta="a TXT record in the domain's DNS" className="mb-4" />
          <div data-testid="gen-record" data-record={record}>
            <DnsRecord
              type="TXT"
              host={`_dmarc.${zone}`}
              zone={zone}
              value={record}
              note={
                domain
                  ? "Replace any DMARC record already at this name: a domain with two answers no policy at all."
                  : "Sample host. Type the domain on the left to fill it in."
              }
            />
          </div>
          {outside.length > 0 ? (
            <p className="mt-3 text-[14px] leading-[1.5] text-fg-2">
              Reports go to {[...new Set(outside)].map((d, i) => (
                <span key={d}>
                  {i > 0 ? ", " : ""}
                  <span className="data">{d}</span>
                </span>
              ))}
              , another domain. Receivers send there only if it publishes{" "}
              <span className="data break-all">{domain}._report._dmarc.{outside[0]}</span> with the value{" "}
              <span className="data">v=DMARC1</span>. Monitoring services publish this for you.
            </p>
          ) : null}
        </div>

        <div>
          <FigureHead name="Policy" meta="where this record puts the domain" className="mb-6" />
          <PolicyLine
            policy={policy}
            note={testing && policy !== "none" ? `With t=y, receivers treat failing mail as p=${policy === "reject" ? "quarantine" : "none"} for now.` : undefined}
          />
        </div>

        {warnings.length > 0 ? (
          <ul data-testid="gen-warnings" className="m-0 flex list-none flex-col gap-2 border-l-[3px] border-warn-mark p-0 pl-4">
            {warnings.map((w) => (
              <li key={w} className="text-[14.5px] leading-[1.5] text-fg-2">
                {w}
              </li>
            ))}
          </ul>
        ) : null}

        <div>
          <FigureHead name="What it makes receivers do" meta="open: set; closed: the default applies" className="mb-6" />
          <StationList
            label="What the generated record makes receivers do"
            items={TAGS.map(({ tag, label, present, absent }) => {
              const value = tags[tag];
              const has = value !== undefined && value !== "";
              const [meaning, tone] = has ? present(value) : typeof absent === "function" ? absent(tags) : absent;
              return {
                key: tag,
                state: has ? "open" : "closed",
                name: label,
                meta: <span className="data break-all">{has ? `${tag}=${value}` : `${tag} not set`}</span>,
                children: <span className={TONE_TEXT[tone]}>{meaning}</span>,
              };
            })}
          />
        </div>
      </div>
    </div>
  );
}
