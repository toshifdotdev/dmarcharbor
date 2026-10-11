/**
 * The sentence a page shows when the entitlements read failed.
 *
 * Without this, a failed GET /workspaces/{id}/entitlements renders as the
 * "not included in your current plan" panel on every settings page, because the
 * check was `entitlements?.features[key] === true` on a null result. A workspace
 * that had paid for the report mailbox was told to upgrade for it.
 *
 * Three values, not two: included, not included, and unknown because the read
 * failed. This component is the third one.
 */
export function PlanUnavailableNotice() {
  return (
    <section
      className="rounded-[2px] border p-4"
      style={{ background: "var(--color-block-soft)", borderColor: "var(--color-block)" }}
      role="status"
    >
      <h2 className="num text-[11px] font-semibold tracking-[0.12em] uppercase" style={{ color: "var(--color-block)" }}>
        Plan not loaded
      </h2>
      <p className="mt-2 text-[13.5px]" style={{ color: "var(--color-ink-2)" }}>
        The plan could not be read, so whether this is available on your workspace is unknown. This is
        an API problem, not a missing feature: nothing has been removed from your plan.
      </p>
    </section>
  );
}
