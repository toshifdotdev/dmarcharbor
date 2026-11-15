import { INDEXNOW_KEY } from "@/lib/crawl-policy";
import { currentHostKind } from "@/lib/site-origin";

/**
 * The IndexNow key file (indexnow.org): proves to Bing, Yandex and the other
 * IndexNow engines that the URLs the deploy workflow submits are ours. The key
 * is public by design; it only lets someone tell those engines that one of our
 * own URLs changed. Ours only, never on an agency's domain.
 */
export async function GET(): Promise<Response> {
  if ((await currentHostKind()) === "agency") {
    return new Response("Not found\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  return new Response(`${INDEXNOW_KEY}\n`, { headers: { "content-type": "text/plain; charset=utf-8" } });
}
