"use server";

/**
 * Server actions for the Data Processing Agreement.
 *
 * A separate module because the banner that calls them is a client component
 * and the writes themselves are not: they read the session cookie and call the
 * API with `credentials: "include"`, which only exists on the server. Importing
 * `lib/api-writes` from the client component directly pulls `next/headers` into
 * the browser bundle and the build fails.
 *
 * The dynamic import inside each action is the same pattern
 * `app/welcome/page.tsx` uses for `createWorkspace`, and for the same reason:
 * it keeps the server-only module out of the client graph entirely rather than
 * relying on it never being reached.
 */

import { revalidatePath } from "next/cache";

export async function acceptRevisedDpa(
  organizationId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { acceptDpa } = await import("@/lib/api-writes");

  try {
    await acceptDpa(organizationId, { hasRead: true, confirmsAuthority: true });
    // The banner is rendered from a server component's read of the acceptance,
    // so revalidating the layouts is what makes it disappear. Without this the
    // write succeeds and the banner stays until the next full navigation.
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "The acceptance could not be recorded.",
    };
  }
}
