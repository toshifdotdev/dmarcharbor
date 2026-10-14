/**
 * ui-errors.ts — what a failed request should actually say.
 *
 * There were two catch blocks in the browser that answered every failure with
 * "The request could not be sent.", which is the one sentence that tells an
 * operator nothing. A JSON parse failure, a proxy that returned an HTML error
 * page, a refused request with a body, and a DNS failure all arrived as the
 * same words, so nobody could tell a broken build from a typo in a form.
 *
 * The rule this module exists to enforce: an API that answered with an error
 * body had something to say, and its message survives. A network failure or an
 * unparseable response is the only case that gets a generic line, and that line
 * names the status it saw rather than hiding it.
 *
 * Nothing here throws. A failed request is a value the form renders, not an
 * exception the component has to guard around.
 */

export interface UiError {
  /** The message to show a person. Never a raw parser or library message. */
  message: string;
  /** The HTTP status, or 0 when no response was received. */
  status: number;
  /** True when the API answered and its error body was read. */
  answered: boolean;
}

/** Statuses that read as "the server is the problem", so the wording differs. */
const SERVER_STATUS = new Set([500, 502, 503, 504]);

const GENERIC = "That could not be completed. Try again in a moment.";
const UNREACHABLE = "We could not reach the server. Check your connection and try again.";

/**
 * Turns a response into a message, reading the API's own words first.
 *
 * Two body shapes reach here. The API's own envelope is `{ error: { code,
 * message } }`. Better Auth's is flatter — `{ message, code }` — because
 * that library flattens its errors, and ignoring the shape is what produced
 * "undefined" where the API had said exactly what was wrong.
 */
export function errorFromResponse(
  status: number,
  rawBody: string,
): UiError {
  let message: string | null = null;

  if (rawBody.trim()) {
    try {
      const parsed = JSON.parse(rawBody) as unknown;
      if (parsed && typeof parsed === "object") {
        const obj = parsed as Record<string, unknown>;
        const nested = obj.error;
        if (nested && typeof nested === "object") {
          const nestedMessage = (nested as Record<string, unknown>).message;
          if (typeof nestedMessage === "string" && nestedMessage.trim()) {
            message = nestedMessage.trim();
          }
        } else if (typeof nested === "string" && nested.trim()) {
          // The Slack controller's flattened shape: { error: "message" }.
          message = nested.trim();
        } else if (typeof obj.message === "string" && obj.message.trim()) {
          message = obj.message.trim();
        }
      }
    } catch {
      // Not JSON. An HTML error page from a proxy, a dev server error overlay,
      // or a truncated body: none of them is the user's fault and none has a
      // readable reason, so the status is the honest answer.
    }
  }

  if (message) {
    return { message, status, answered: true };
  }

  return { message: genericForStatus(status), status, answered: false };
}

/** The words for a status the API never explained. */
export function genericForStatus(status: number): string {
  if (status === 0) return UNREACHABLE;
  if (status === 401) return "You are not signed in. Sign in and try again.";
  if (status === 403) return "You do not have permission to do that in this workspace.";
  if (status === 404) return "That could not be found.";
  if (status === 409) return "That already exists. Check the details and try again.";
  if (status === 402) return "Your plan does not include that.";
  if (status === 429) return "Too many attempts. Wait a minute and try again.";
  if (SERVER_STATUS.has(status)) {
    return `${GENERIC} (The server reported ${status}.)`;
  }
  return GENERIC;
}

/**
 * The one entry point for a browser request whose result a form renders.
 *
 * `fetch` throwing and the response not being JSON are two different failures
 * with the same effect, and only one of them is the network's fault. Both are
 * reported, and neither is reported as "the request could not be sent".
 */
export async function readUiError(res: Response): Promise<UiError> {
  try {
    return errorFromResponse(res.status, await res.text());
  } catch {
    // A body that cannot even be read: the status is all that is left.
    return { message: genericForStatus(res.status), status: res.status, answered: false };
  }
}

/** A message for a thrown `fetch`, which means no response ever arrived. */
export function networkUiError(): UiError {
  return { message: UNREACHABLE, status: 0, answered: false };
}

/**
 * The API's own error `code`, if it sent one.
 *
 * Kept separate from the message because a caller routes behaviour on the code —
 * `PLAN_LIMIT_REACHED` opens an upgrade prompt, `CONFLICT` highlights a field —
 * and both of those have to survive even when the message is the generic one.
 *
 * Reads the nested and the flattened shape, because the API uses the first
 * (`{ error: { code, message } }`) and better-auth uses the second.
 */
export function extractErrorCode(rawBody: string): string | null {
  if (!rawBody.trim()) return null;
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const obj = parsed as Record<string, unknown>;

    const nested = obj.error;
    if (nested && typeof nested === "object") {
      const code = (nested as Record<string, unknown>).code;
      if (typeof code === "string" && code.trim()) return code.trim();
    } else if (typeof nested === "string" && nested.trim()) {
      // Slack's controller sends { error: "message" } with no code at all.
      return "REQUEST_FAILED";
    }
    if (typeof obj.code === "string" && obj.code.trim()) return obj.code.trim();
    return null;
  } catch {
    return null;
  }
}
