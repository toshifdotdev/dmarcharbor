/**
 * chat-kinds.ts — the kinds of message a Slack or Teams channel can be routed
 * to, in the words an MSP routes by. The same five the API routes on
 * (apps/api/src/services/chat-routing.ts chatKinds).
 */

export const CHAT_KINDS = [
  { id: "failures", name: "Failing mail", kind: "failure count, failure rate, failure samples" },
  { id: "spoofing", name: "Spoofing and new senders", kind: "volume from one source, new unauthenticated senders" },
  { id: "silence", name: "Reports stopped", kind: "no report for a while" },
  { id: "dns", name: "DNS changes", kind: "records added, changed or removed" },
  { id: "expiry", name: "Domain expiry", kind: "registration about to lapse" },
] as const;

export type ChatKindId = (typeof CHAT_KINDS)[number]["id"];

/** "Every kind of message", or the chosen kinds in a sentence. */
export function kindsSentence(kinds: string[]): string {
  if (kinds.length === 0) return "every kind of message";
  const names = CHAT_KINDS.filter((k) => kinds.includes(k.id)).map((k) => (k.name.startsWith("DNS") ? k.name : k.name.toLowerCase()));
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : (names[0] ?? "nothing");
}

/** "every client", or the chosen clients by name. */
export function clientsSentence(clientIds: string[], clients: Array<{ id: string; name: string }> | null): string {
  if (clientIds.length === 0) return "every client";
  const names = (clients ?? []).filter((c) => clientIds.includes(c.id)).map((c) => c.name);
  if (names.length === 0) return `${clientIds.length} chosen client${clientIds.length === 1 ? "" : "s"}`;
  if (names.length <= 2) return names.join(" and ");
  return `${names[0]}, ${names[1]} and ${names.length - 2} more`;
}
