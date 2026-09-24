"use client";

import { type RefObject, useEffect, useState } from "react";
import type { PlanPhase } from "./usePlanTrip";

// Where keyboard focus goes when the page itself changes shape (edits have lib/editFocus.ts):
// - a new plan: the day heading, so keyboard and screen reader users land on it;
// - "Edit trip": the form's heading; "Back to plan": the "Edit trip" button again;
// - sending the form: the plan area, which now shows the plan's skeleton (the button that had
//   focus just folded away with the form);
// - a failed plan: its message is brought into view, and if focus was left on a region that is
//   gone (no earlier plan to go back to), it moves to the message's button or "Plan my trip".

export type FocusTarget = "form" | "edit" | "plan";

interface PageFocusOptions {
  phase: PlanPhase;
  planId: number;
  dayHeading: RefObject<HTMLElement | null>;
  formHeading: RefObject<HTMLElement | null>;
}

function lost(doc: Document): boolean {
  const active = doc.activeElement;
  return !active || active === doc.body || !active.isConnected;
}

export function usePageFocus({ phase, planId, dayHeading, formHeading }: PageFocusOptions) {
  const [next, setNext] = useState<FocusTarget | null>(null);

  useEffect(() => {
    if (planId > 0) dayHeading.current?.focus({ preventScroll: false });
  }, [planId, dayHeading]);

  useEffect(() => {
    if (!next) return;
    setNext(null);
    if (next === "form") formHeading.current?.focus();
    else if (next === "plan") {
      // The form that had focus just folded away; the page is now the summary line and the
      // plan's skeleton, so show it from the top rather than wherever the long form was.
      document.getElementById("plan")?.focus({ preventScroll: true });
      (document.scrollingElement ?? document.documentElement).scrollTop = 0;
    } else document.querySelector<HTMLElement>('[data-testid="edit-trip-button"]')?.focus();
  }, [next, formHeading]);

  useEffect(() => {
    if (phase.kind !== "error") return;
    const error = document.getElementById("plan-error");
    error?.scrollIntoView?.({ block: "nearest" });
    if (!lost(document)) return;
    const button = error?.querySelector("button");
    const target = button ?? document.querySelector('[data-testid="plan-button"]');
    if (target instanceof HTMLElement) target.focus();
  }, [phase]);

  return setNext;
}
