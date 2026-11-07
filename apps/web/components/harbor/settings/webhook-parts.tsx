"use client";

/**
 * webhook-parts.tsx — the two choices an endpoint gained: which clients it
 * hears about, and how long an old signing secret keeps signing after a
 * rotation. Drawn as the settings pages draw everything: a segmented choice,
 * then the list, then what the choice means in a sentence.
 */

import { Checkbox } from "@/components/ui/choice";
import { Segmented } from "@/components/ui/field";

export type ClientChoice = { id: string; name: string };

/** Every client, or chosen ones. An empty choice of "chosen" is not allowed. */
export function ClientScope({
  clients,
  scope,
  onScope,
  chosen,
  onChosen,
  disabled,
}: {
  clients: ClientChoice[] | null;
  scope: "all" | "some";
  onScope: (scope: "all" | "some") => void;
  chosen: string[];
  onChosen: (ids: string[]) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset className="flex flex-col gap-2.5" data-testid="webhook-client-scope">
      <legend className="mb-1 text-meta font-semibold text-fg-2">For which clients</legend>
      <div className="flex">
      <Segmented
        label="For which clients"
        size="sm"
        value={scope}
        onChange={onScope}
        options={[
          { value: "all", label: "Every client" },
          { value: "some", label: "Chosen clients" },
        ]}
      />
      </div>
      {scope === "all" ? (
        <p className="text-meta text-fg-3">Events about every client&rsquo;s domains, including clients added later.</p>
      ) : clients === null ? (
        <p className="text-meta text-warn">The client list could not be read. Reload to choose clients.</p>
      ) : clients.length === 0 ? (
        <p className="text-meta text-fg-3">There are no clients yet.</p>
      ) : (
        <>
          <div className="grid max-h-56 gap-2 overflow-y-auto pr-1 sm:grid-cols-2">
            {clients.map((c) => (
              <Checkbox
                key={c.id}
                checked={chosen.includes(c.id)}
                onChange={(e) => onChosen(e.target.checked ? [...chosen, c.id] : chosen.filter((x) => x !== c.id))}
                label={c.name}
                disabled={disabled}
                data-testid={`webhook-client-${c.id}`}
              />
            ))}
          </div>
          <p className={chosen.length === 0 ? "text-meta font-medium text-fail" : "text-meta text-fg-3"}>
            {chosen.length === 0
              ? "Choose at least one client."
              : "Only these clients' domain events are sent. Workspace events, such as a plan limit, still are."}
          </p>
        </>
      )}
    </fieldset>
  );
}

export const OVERLAPS = [
  { value: "24", label: "1 day" },
  { value: "168", label: "7 days" },
  { value: "1", label: "1 hour" },
  { value: "0", label: "None" },
] as const;
export type OverlapValue = (typeof OVERLAPS)[number]["value"];

/**
 * The rotation drawn as two lines: the new secret signing from now on, the
 * old one signing beside it until the overlap ends, then stopping.
 */
export function RotationLine({ overlap }: { overlap: OverlapValue }) {
  const none = overlap === "0";
  const span = OVERLAPS.find((o) => o.value === overlap)?.label ?? "";
  return (
    <figure className="m-0 flex flex-col gap-2" aria-label={none ? "The old secret stops now; only the new one signs." : `Both secrets sign for ${span}, then only the new one.`}>
      <svg viewBox="0 0 320 64" className="block h-16 w-full max-w-[22rem]" aria-hidden>
        {/* New secret: from now, on. */}
        <line x1="12" x2="306" y1="18" y2="18" stroke="var(--color-done)" strokeWidth="5" strokeLinecap="round" />
        <circle cx="12" cy="18" r="6" fill="var(--color-paper)" stroke="var(--color-fg)" strokeWidth="3" />
        {/* Old secret: until the overlap ends, then refused. */}
        {none ? (
          <rect x="9.5" y="38" width="5" height="16" rx="2.5" fill="var(--color-fail)" />
        ) : (
          <>
            <line x1="12" x2="190" y1="46" y2="46" stroke="var(--color-fg-4)" strokeWidth="5" strokeDasharray="8 6" />
            <rect x="190" y="38" width="5" height="16" rx="2.5" fill="var(--color-fg-3)" />
          </>
        )}
      </svg>
      <figcaption className="grid gap-1 text-meta">
        <span>
          <span className="font-semibold text-fg">New secret</span> <span className="text-fg-3">signs every delivery from now</span>
        </span>
        <span>
          <span className="font-semibold text-fg">Old secret</span>{" "}
          <span className="text-fg-3">{none ? "stops now: use this if it has leaked" : `signs beside it for ${span}, then stops`}</span>
        </span>
      </figcaption>
    </figure>
  );
}
