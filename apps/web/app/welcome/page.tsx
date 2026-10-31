import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Fragment } from "react";
import { ApiError, listWorkspaces, readWorkspaceAllowance, type WorkspaceAllowance } from "@/lib/api";
import { signInRedirect } from "@/lib/session";
import type { WorkspaceSummary } from "@/lib/types";
import { AuthFrame } from "@/components/harbor/auth-frame";
import { InvitationsForYou } from "@/components/harbor/invitations";
import { SetupLayout } from "@/components/harbor/setup-rail";
import { WorkspaceSetup, type WorkspaceFormState } from "@/components/harbor/workspace-setup";

/**
 * /welcome — the first workspace, or another one.
 *
 * A newcomer arrives here straight from the verification link (it signs them
 * in), so the page opens by saying where they are on the route. Someone who
 * already has workspaces gets the same form with what they already hold and
 * how many more their plan allows, read from the allowance endpoint rather
 * than discovered by a refused creation.
 *
 * The action FAILS CLOSED: an unchecked box is a named refusal on the form,
 * and the Terms and DPA confirmations ride on the creation call itself, so a
 * workspace can never exist without its acceptance record. The new workspace
 * becomes the active one before the redirect, so a second workspace opens on
 * itself rather than on the one you already had.
 */
async function createWorkspaceAction(_prev: WorkspaceFormState, formData: FormData): Promise<WorkspaceFormState> {
  "use server";
  const name = String(formData.get("name") ?? "").trim();
  const slug = String(formData.get("slug") ?? "").trim();
  if (name.length < 2) return { error: "Give the workspace a name of at least two characters.", field: "name" };
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    return { error: "Use lowercase letters, digits and single hyphens for the slug.", field: "slug" };
  }
  if (formData.get("tos-accept") !== "on") {
    return {
      error: "Accept the Terms of Service to continue. They apply on every plan, the free one included.",
      field: "tos",
    };
  }
  if (formData.get("dpa-accept") !== "on" || formData.get("dpa-authorised") !== "on") {
    return {
      error: "Tick both Data Processing Agreement boxes: that you accept it, and that you are authorised to accept it for this organisation.",
      field: "dpa",
    };
  }

  const { createWorkspace } = await import("@/lib/api-writes");
  let created: { id: string } | null;
  try {
    created = await createWorkspace({ name, slug, tosAccepted: true, dpaHasRead: true, dpaConfirmsAuthority: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The workspace could not be created.";
    if (/agreement|dpa/i.test(message)) return { error: message, field: "dpa" };
    if (/slug|exists|taken/i.test(message)) {
      return { error: `${message} Try a different slug.`, field: "slug" };
    }
    return { error: message, field: "name" };
  }
  if (!created?.id) {
    return {
      error: "The workspace was created but the API did not return its identifier. Contact support before continuing.",
      field: null,
    };
  }

  // Open on the new workspace, not on whichever was active before.
  (await cookies()).set("harbor.workspace", created.id, { path: "/", maxAge: 31_536_000, sameSite: "lax" });
  redirect("/");
}

export default async function WelcomePage() {
  let workspaces: WorkspaceSummary[];
  try {
    workspaces = await listWorkspaces();
  } catch (error) {
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) await signInRedirect();
    throw error;
  }
  const hasOne = workspaces.length > 0;
  const allowance: WorkspaceAllowance | null = await readWorkspaceAllowance().catch(() => null);

  const form = (
    <WorkspaceSetup
      action={createWorkspaceAction}
      disableSubmit={allowance ? !allowance.allowed : false}
      limitReason={
        allowance && !allowance.allowed
          ? `All ${allowance.maxWorkspaces} workspaces your plan allows are in use. A higher plan allows more.`
          : null
      }
    />
  );

  if (!hasOne) {
    // The first workspace: stop three of six, beside the route.
    return (
      <AuthFrame width="route">
        <SetupLayout current="workspace">
          <div className="flex flex-col gap-8">
            <InvitationsForYou />
            <div>
              <p className="flex items-center gap-2 text-meta font-semibold text-ok">
                <span aria-hidden className="block size-2 bg-ok" />
                Email verified. You are signed in.
              </p>
              <h1 className={`mt-3 ${HEADING}`}>Name your workspace</h1>
              <p className="mt-3 text-lead text-fg-2">
                It holds your clients, their domains, and every report receivers send about them. Next you add a first
                client and domain, and get the records to publish.
              </p>
            </div>
            {form}
          </div>
        </SetupLayout>
      </AuthFrame>
    );
  }

  const strip = allowance && allowance.maxWorkspaces > 0 && allowance.maxWorkspaces <= 12;
  return (
    <AuthFrame
      width="wide"
      aside={
        <Link href="/" className="link font-semibold">
          Back to the portfolio
        </Link>
      }
    >
      <div className="grid gap-12 md:grid-cols-[minmax(0,1fr)_280px] md:gap-16">
        <div className="flex min-w-0 flex-col gap-8">
          <InvitationsForYou />
          <div>
            <h1 className={HEADING}>Add another workspace</h1>
            <p className="mt-3 text-lead text-fg-2">
              A workspace holds its own clients, domains and measurements, and carries its own plan. Nothing is shared
              with the ones you already have.
            </p>
          </div>
          {form}
        </div>

        <aside aria-labelledby="ws-held" className="flex flex-col gap-4 md:pt-2">
          <div className="flex flex-wrap items-baseline gap-x-3 border-b border-rule pb-3">
            <h2 id="ws-held" className="text-[15px] font-bold text-fg">
              On this account
            </h2>
            <p className="text-ui text-fg-4">your workspaces</p>
          </div>
          {allowance ? (
            <div data-testid="workspace-allowance">
              <p className="text-body text-fg-3">
                <span className="tnum text-h2 font-bold text-fg">{allowance.used}</span> of{" "}
                <span className="tnum">{allowance.maxWorkspaces}</span> used
              </p>
              {strip ? (
                // One station per workspace the plan allows: filled where one is in use.
                <div aria-hidden className="mt-3 flex h-[14px] items-center">
                  {Array.from({ length: allowance.maxWorkspaces }, (_, i) => (
                    <Fragment key={i}>
                      {i > 0 ? (
                        <span className={`-mx-px h-[5px] flex-1 ${i < allowance.used ? "bg-act" : "bg-rule"}`} />
                      ) : null}
                      <span
                        className={`relative z-[1] block size-[14px] shrink-0 rounded-full border-[3px] ${
                          i < allowance.used ? "border-act bg-act" : "border-rule-2 bg-paper"
                        }`}
                      />
                    </Fragment>
                  ))}
                </div>
              ) : null}
              <p className="mt-3 text-meta text-fg-3">The limit comes from your strongest plan across your workspaces.</p>
            </div>
          ) : (
            <p className="text-meta text-fg-3">The workspace allowance could not be read. The API checks it when you create one.</p>
          )}
          <ul className="flex flex-col border-t border-rule">
            {workspaces.map((w) => (
              <li key={w.id} className="border-b border-rule py-2.5">
                <span className="block text-ui font-semibold text-fg">{w.name}</span>
                <span className="data block text-meta text-fg-3">{w.slug}</span>
              </li>
            ))}
          </ul>
        </aside>
      </div>
    </AuthFrame>
  );
}

const HEADING = "text-balance text-[34px] font-[760] leading-[1.02] tracking-[-0.035em] text-fg sm:text-[40px]";
