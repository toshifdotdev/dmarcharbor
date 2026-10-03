import { redirect } from "next/navigation";
import { ApiError, listWorkspaces } from "@/lib/api";
import { PierMark } from "@/components/mark";

/**
 * No workspace yet is an onboarding step, not an error. Creating one here is
 * the same POST /api/workspaces the API documents — no invented endpoints.
 */
export default async function WelcomePage() {
  // Only signed-in newcomers name a workspace; a 401 here is a stranger at
  // the door, not an error page (this route used to crash on the throw).
  let workspaces;
  try {
    workspaces = await listWorkspaces();
  } catch (error) {
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
      redirect("/sign-in");
    }
    throw error;
  }
  if (workspaces.length > 0) redirect("/");

  return (
    <main className="relative z-10 flex min-h-screen flex-col items-center justify-center gap-8 px-6">
      <PierMark size={40} />
      <h1
        className="text-[25.5px] font-semibold tracking-[-0.03em]"
        style={{ fontFamily: "var(--font-display)" }}
      >
        Name your workspace
      </h1>
      <p className="max-w-sm text-center text-[14.5px]" style={{ color: "var(--color-ink-2)" }}>
        A workspace holds your clients, their domains, and every measurement
        you collect. Your agency's brand is applied to client-facing surfaces.
      </p>
      <WorkspaceForm />
    </main>
  );
}

function WorkspaceForm() {
  return (
    <form
      action={async (formData: FormData) => {
        "use server";
        const name = String(formData.get("name") ?? "").trim();
        const slug = String(formData.get("slug") ?? "").trim();
        if (name.length < 2 || slug.length < 2) return;
        // Both boxes are real gates: a workspace is created only by someone
        // who accepted the DPA AND is authorised to accept it for the
        // organisation. This mirrors the form; the API's own DPA gate (when
        // its status shape lands) is the second lock.
        if (formData.get("dpa-accept") !== "on") return;
        if (formData.get("dpa-authorised") !== "on") return;

        const { createWorkspace } = await import("@/lib/api-writes");
        const { listWorkspaces: lw } = await import("@/lib/api");
        await createWorkspace({ name, slug });
        const after = await lw();
        redirect(after.length > 0 ? "/" : "/welcome");
      }}
      className="flex w-full max-w-sm flex-col gap-4"
    >
      <label className="flex flex-col gap-1.5">
        <span className="label">Workspace name</span>
        <input
          name="name"
          required
          minLength={2}
          maxLength={80}
          placeholder="Example Agency"
          className="rounded-[2px] border px-3 py-2 text-[15px] outline-none"
          style={{
            background: "var(--color-surface)",
            borderColor: "var(--color-line-strong)",
            color: "var(--color-ink)",
          }}
        />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="label">Slug</span>
        <input
          name="slug"
          required
          minLength={2}
          pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
          placeholder="example-agency"
          className="num rounded-[2px] border px-3 py-2 text-[14.5px] outline-none"
          style={{
            background: "var(--color-surface)",
            borderColor: "var(--color-line-strong)",
            color: "var(--color-ink)",
          }}
        />
      </label>
      {/* Two boxes, both required, neither pre-ticked. The second is the one
          that matters: an employee signing up has not been authorised by their
          firm. */}
      <fieldset className="mt-1 flex flex-col gap-2.5">
        <legend className="label">Before you create the workspace</legend>
        <label className="flex items-start gap-2.5 text-[13px] leading-[1.6]" style={{ color: "var(--color-ink-2)" }}>
          <input type="checkbox" name="dpa-accept" required className="mt-1" />
          <span>
            I have read and accept the{" "}
            <a href="/dpa" target="_blank" rel="noreferrer" className="underline" style={{ color: "var(--color-ink)" }}>
              Data Processing Agreement
            </a>
            .
          </span>
        </label>
        <label className="flex items-start gap-2.5 text-[13px] leading-[1.6]" style={{ color: "var(--color-ink-2)" }}>
          <input type="checkbox" name="dpa-authorised" required className="mt-1" />
          <span>
            I confirm I am authorised to accept on behalf of this organisation.
          </span>
        </label>
      </fieldset>
      <button
        type="submit"
        className="mt-2 rounded-[2px] px-5 py-2.5 text-[14.5px] font-semibold"
        style={{ background: "var(--color-accent)", color: "var(--color-accent-ink)" }}
      >
        Create workspace
      </button>
    </form>
  );
}
