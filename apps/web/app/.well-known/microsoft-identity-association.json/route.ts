import { currentHostKind } from "@/lib/site-origin";
/**
 * /.well-known/microsoft-identity-association.json: proves to Microsoft Entra
 * that dmarcharbor.com publishes our "Sign in with Microsoft" app, so its
 * consent screen names dmarcharbor.com as the publisher domain instead of the
 * directory's onmicrosoft.com name.
 *
 * The application id is the app registration's client id, which every
 * Microsoft sign-in URL already carries, so it is not a secret. A new app
 * registration means a new id here.
 *
 * Not served on an agency's verified domain (404): the file speaks for the
 * operator of the site, and on that domain the site is the agency's.
 */
const MICROSOFT_APPLICATION_ID = "12379ef9-f116-4e37-8807-9f8e2ae13100";

export const dynamic = "force-dynamic";
export async function GET(): Promise<Response> {
  if ((await currentHostKind()) === "agency") {
    return new Response("Not found\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  const body = { associatedApplications: [{ applicationId: MICROSOFT_APPLICATION_ID }] };
  return new Response(JSON.stringify(body, null, 2) + "\n", {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
