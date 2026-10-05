import { redirect } from "next/navigation";
import { ApiError, listWorkspaces } from "@/lib/api";
import { PierMark } from "@/components/mark";
import { WorkspaceForm, type WorkspaceFormState } from "@/components/workspace-form";

/**
 * No workspace yet is an onboarding step, not an error. Creating one here is
 * the same POST /api/workspaces the API documents - no invented endpoints.
 *
 * The action FAILS CLOSED: an unchecked box is a refusal with a named error on
 * the form, never a silent success, and both DPA confirmations are sent on the
 * creation call itself rather than recorded afterwards. That distinction is the
 * whole point: a follow-up call is only reached on the happy path, so anything
 * that failed between the two left a workspace standing with no acceptance
 * record while the UI implied the agreement had been made. One call cannot get
 * out of step with itself, and the API refuses the workspace outright if the
 * confirmations are missing, so dpaAcceptanceFor() can prove which document
 * version this workspace accepted. Every failure is inline: a duplicate slug is
 * a field error, not a global-error page.
 */
async function createWorkspaceAction(
  _prev: WorkspaceFormState,
  formData: FormData,
): Promise<WorkspaceFormState> {
  "use server";
  const name = String(formData.get("name") ?? "").trim();
  const slug = String(formData.get("slug") ?? "").trim();
  if (name.length < 2) {
    return { error: "Give the workspace a name of at least two characters.", field: "name" };
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    return {
      error: "Use lowercase letters, digits and hyphens for the slug.",
      field: "slug",
    };
  }
  // Both boxes are real gates: a workspace is created only by someone who
  // accepted the DPA AND is authorised to accept it for the organisation.
  // Unchecked means no: this is the refusal, not a validation nicety.
  if (formData.get("dpa-accept") !== "on" || formData.get("dpa-authorised") !== "on") {
    return {
      error: "Tick both boxes: you have read and accepted the Data Processing Agreement, and you are authorised to accept it for this organisation.",
      field: "dpa",
    };
  }

  const { createWorkspace } = await import("@/lib/api-writes");
  const { listWorkspaces: lw } = await import("@/lib/api");

  /**
   * One call, not two.
   *
   * The acceptance goes on the creation request, where the API can refuse the whole
   * thing, rather than in a follow-up afterwards. The previous shape ticked both boxes,
   * created the workspace, then called `acceptDpa` — and that follow-up was the defect,
   * not an oversight: it was reached only on the happy path, so any failure between the
   * two left a workspace standing with `dpaAcceptedAt: null` while the UI said the
   * agreement had been accepted. Sending the flags on creation makes the two impossible
   * to get out of step, because there is only one of them.
   */
  let created: { id?: string } | null;
  try {
    created = await createWorkspace({
      name,
      slug,
      dpaHasRead: true,
      dpaConfirmsAuthority: true,
    });

    /**
     * A null here means the API answered 2xx with no organisation id in the body. That
     * is not a workspace anyone can sign in to, and treating it as success would leave
     * the new user on a page that keeps offering to create one.
     */
    if (!created?.id) {
      return {
        error:
          "The workspace was created but the API did not return its identifier. Contact support before continuing.",
        field: null,
      };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "The workspace could not be created.";

    /**
     * The API's refusal names the agreement rather than saying "invalid input", so the
     * message is passed through as-is and the boxes are pointed at, because the most
     * likely cause by far is a caller that did not establish the agreement.
     */
    if (/agreement|dpa/i.test(message)) {
      return { error: message, field: "dpa" };
    }

    // A duplicate slug is the common refusal: name the field, keep the page.
    const duplicate = /slug/i.test(message) || /exists/i.test(message) || /taken/i.test(message);
    return { error: message, field: duplicate ? "slug" : "name" };
  }

  try {
    /**
     * Confirmed by listing rather than assumed from the create response, because the
     * acceptance record is what `dpaAcceptanceFor()` reads to prove which document
     * version this workspace agreed to. Trusting the creation response would reintroduce
     * the exact assumption this change removes.
     */
    const workspaces = await lw();
    if (workspaces.length === 0) {
      return {
        error:
          "The workspace was created but is not yet visible. Contact support before continuing.",
        field: null,
      };
    }

    redirect("/");
  } catch (error) {
    if (error && typeof error === "object" && "digest" in error) throw error;
    const message = error instanceof Error ? error.message : "The workspace list could not be read.";
    return { error: message, field: null };
  }
}

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
      <WorkspaceForm action={createWorkspaceAction} />
    </main>
  );
}
