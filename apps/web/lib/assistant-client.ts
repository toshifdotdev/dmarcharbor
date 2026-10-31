/**
 * assistant-client.ts — the product assistant's two calls, through the
 * same-origin proxy like every other browser call (ops-client.ts).
 *
 * The assistant answers from the product's documentation only. The workspace
 * id in the path decides whether the plan carries it and whose daily budget
 * a question spends; nothing about the workspace is sent to it.
 */

import { opsCall } from "./ops-client";

export interface AssistantSource {
  id: string;
  /** The page, set bold: "FAQ", "Setup guide", "Pricing". */
  page: string;
  /** The section, set lighter beside it. */
  section: string | null;
  /** A public path with the heading anchor. */
  url: string;
}

export type AssistantOutcome = "answered" | "unknown" | "refused" | "links_only";

export interface AssistantReply {
  outcome: AssistantOutcome;
  reason: string | null;
  answer: string | null;
  message: string | null;
  sources: AssistantSource[];
  sourcesLabel: string | null;
  followUps: string[];
  support: { url: string; email: string };
  mode: "written" | "links";
  cached: boolean;
}

export interface AssistantIntro {
  mode: "written" | "links";
  starters: Array<{ task: string; questions: string[] }>;
  support: { url: string; email: string };
  maxQuestionChars: number;
  limits: { perMinute: number; perWorkspacePerDay: number };
}

/** GET /assistant — starters, mode and limits. A 402 says which plan carries it. */
export const getAssistantIntro = (orgId: string) => opsCall<AssistantIntro>(`/api/workspaces/${orgId}/assistant`);

/** POST /assistant/ask — one question, one reply. */
export const askAssistant = (orgId: string, question: string) =>
  opsCall<AssistantReply>(`/api/workspaces/${orgId}/assistant/ask`, {
    method: "POST",
    body: JSON.stringify({ question }),
  });
