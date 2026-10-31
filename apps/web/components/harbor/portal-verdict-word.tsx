/**
 * portal-verdict-word.tsx — a domain's verdict as the portal shows it: the
 * verdict's title in its state colour, with the shape every state carries so
 * nothing is said in colour alone.
 *
 * The shapes follow the product's posture marks: a diamond for something
 * failing, a ring for "not yet blocking", a half-filled square where reports
 * stopped, a hatched square where nothing has been measured, a filled square
 * for passing. The verdict itself (its words and its tone) is lib/portal-verdict's.
 */

import type { Verdict, VerdictKind } from "@/lib/portal-verdict";
import { StateWord, type MarkShape, type MarkTone } from "./document-route";

const SHAPE: Record<VerdictKind, MarkShape> = {
  attention: "diamond",
  silent: "half",
  waiting: "hatch",
  watching: "ring",
  passing: "square",
  protected: "square",
  unknown: "hatch",
};

const TONE: Record<Verdict["tone"], MarkTone> = {
  fail: "fail",
  warn: "warn",
  ok: "ok",
  neutral: "void",
};

export function VerdictWord({ verdict, size = "md" }: { verdict: Verdict; size?: "md" | "lg" }) {
  return (
    <StateWord shape={SHAPE[verdict.kind]} tone={TONE[verdict.tone]} size={size}>
      {verdict.title}
    </StateWord>
  );
}
