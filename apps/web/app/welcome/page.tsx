import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Fragment } from "react";
import { ApiError, getSessionUser, listWorkspaces, readWorkspaceAllowance, type WorkspaceAllowance } from "@/lib/api";
import { getPortalOverview, PortalError } from "@/lib/api-portal";
import { buttonClass } from "@/components/ui/button";
import { signInRedirect } from "@/lib/session";
import type { WorkspaceSummary } from "@/lib/types";
import { AuthFrame } from "@/components/harbor/auth-frame";
import { InvitationsForYou } from "@/components/harbor/invitations";
import { PlanLimitNotice } from "@/components/harbor/plan-refusal";
import { SetupLayout } from "@/components/harbor/setup-rail";
import { VerifyEmailNotice } from "@/components/harbor/verify-email-notice";
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

  const { createWorkspace, WorkspaceCreateError } = await import("@/lib/api-writes");
  let created: { id: string } | null;
  try {
    created = await createWorkspace({ name, slug, tosAccepted: true, dpaHasRead: true, dpaConfirmsAuthority: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The workspace could not be created.";
    // The allowance ran out between reading the page and pressing the button:
    // a plan matter, said as one, with the way to Billing.
    if (error instanceof WorkspaceCreateError && error.limitReached) return { error: message, field: null, limit: true };
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

/**
 * Better Auth sends a verification link that failed back to its callback
 * (this page) as ?error=CODE, and that click carries no session. Without this
 * the code was dropped on the way to sign-in and the person saw a bare form.
 */
const VERIFY_ERRORS: Record<string, string> = {
  TOKEN_EXPIRED: "verify_expired",
  INVALID_TOKEN: "verify_invalid",
  USER_NOT_FOUND: "verify_invalid",
  INVALID_USER: "verify_invalid",
};

export default async function WelcomePage({ searchParams }: { searchParams: Promise<{ error?: string | string[] }> }) {
  const { error: rawError } = await searchParams;
  const verifyError = VERIFY_ERRORS[(Array.isArray(rawError) ? rawError.at(-1) : rawError) ?? ""] ?? null;
  let workspaces: WorkspaceSummary[];
  try {
    workspaces = await listWorkspaces();
  } catch (error) {
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
      if (verifyError) redirect(`/sign-in?error=${verifyError}`);
      await signInRedirect();
    }
    throw error;
  }
  const hasOne = workspaces.length > 0;
  const allowance: WorkspaceAllowance | null = await readWorkspaceAllowance().catch(() => null);
  // Read, not assumed: "Email verified" was printed for every account, including
  // a Microsoft one whose address had not been confirmed.
  const user = await getSessionUser();
  const workspacesFull = allowance !== null && !allowance.allowed;
  /**
   * A client contact who signs in on the main sign-in page (not through the
   * invitation's /portal link) has no workspace and lands here. Session 13
   * found that they met "Name your workspace", with the way to their report
   * in a footnote under the form. When their address holds a portal grant the
   * report is offered first; the form stays for someone who is also an agency.
   * The clients named, or an empty list when several providers share them.
   */
  const reportFor: string[] | null = hasOne
    ? null
    : await getPortalOverview().then(
        (overview) => overview.clients.map((client) => client.name),
        (error: unknown) => (error instanceof PortalError && error.code === "CHOOSE_WORKSPACE" ? [] : null),
      );

  // At the allowance the form is not offered: the API would refuse it. The
  // limit is said in its place, with the way to Billing.
  const form =
    workspacesFull && allowance ? (
      <PlanLimitNotice
        quota="workspace"
        message={`Your plan allows ${allowance.maxWorkspaces} workspace${allowance.maxWorkspaces === 1 ? "" : "s"}, and you own ${allowance.used}.`}
        context="The allowance comes from the plan on your account, and only workspaces you own count toward it: workspaces you were invited to do not. Delete one you own and no longer use, hand one to a colleague under Members, or upgrade your plan."
      />
    ) : (
      <WorkspaceSetup action={createWorkspaceAction} />
    );

  if (!hasOne) {
    // The first workspace: stop three of six, beside the route.
    return (
      <AuthFrame width="route">
        <SetupLayout current="workspace">
          <div className="flex flex-col gap-8">
            {reportFor ? (
              <section
                aria-labelledby="welcome-portal-head"
                className="flex flex-col items-start gap-3 border-b border-rule pb-8"
                data-testid="welcome-portal"
              >
                <h2 id="welcome-portal-head" className="text-h3 font-bold text-fg">
                  A client report is shared with you
                </h2>
                <p className="text-body text-fg-2">
                  {reportFor.length > 0 ? (
                    <>
                      The company that manages your email security shares the report for{" "}
                      <span className="font-semibold text-fg">{reportFor.join(", ")}</span> with this address.
                    </>
                  ) : (
                    "More than one company that manages your email security shares a report with this address."
                  )}{" "}
                  You do not need a workspace to read it.
                </p>
                <Link href="/portal" className={buttonClass("primary", "md")}>
                  Open your client reports
                </Link>
              </section>
            ) : null}
            <InvitationsForYou explainLapsed />
            {user && !user.emailVerified ? <VerifyEmailNotice email={user.email} /> : null}
            <div>
              {user?.emailVerified ? (
                <p className="flex items-center gap-2 text-meta font-semibold text-ok">
                  <span aria-hidden className="block size-2 bg-ok" />
                  Email verified. You are signed in.
                </p>
              ) : null}
              <h1 className={`${user?.emailVerified ? "mt-3 " : ""}${HEADING}`}>Name your workspace</h1>
              <p className="mt-3 text-lead text-fg-2">
                It holds your clients, their domains, and every report receivers send about them. Next you add a first
                client and domain, and get the records to publish.
              </p>
            </div>
            {form}
            {/* A client's contact who signs in here (a portal grant, no
                membership) has no workspace and lands on this page from any
                agency screen. They need the portal, not a workspace. Said at
                the top instead when their grant could be read. */}
            {reportFor ? null : (
            <p className="text-ui text-fg-3">
              Here to read a report that the company managing your email security shares with you? You do not need a
              workspace:{" "}
              <Link href="/portal" className="link font-semibold">
                open your client reports
              </Link>
              .
            </p>
            )}
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
          <InvitationsForYou explainLapsed />
          <div>
            <h1 className={HEADING}>Add another workspace</h1>
            <p className="mt-3 text-lead text-fg-2">
              A workspace holds its own clients, domains and measurements, and nothing in it is shared with the others.
              Every workspace you own follows the plan on your account and counts toward its limits.
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

const HEADING = "text-balance text-[34px] font-[760] leading-[0.96] tracking-[-0.035em] text-fg sm:text-[40px]";
