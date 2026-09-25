"use client";

import { type RefObject, useEffect, useState } from "react";
import type { PlanPhase } from "./usePlanTrip";

// Where keyboard focus goes when the page itself changes shape (edits have lib/editFocus.ts;
// a sheet puts focus on its own heading when it opens, see components/Sheet.tsx):
// - a new plan: the day heading, so keyboard and screen reader users land on it;
// - closing the Edit trip sheet without planning: the "Edit trip" button again;
// - sending the form: the plan area, which now shows the plan's skeleton (the button that had
//   focus just went away with the sheet);
// - "Start a new trip": the first screen's title, at the top of the page;
// - a failed plan: its message is brought into view, and if focus was left on a region that is
//   gone (no earlier plan to go back to), it moves to the message's button or "Plan my trip".

export type FocusTarget = "edit" | "plan" | "start";

interface PageFocusOptions {
  phase: PlanPhase;
  planId: number;
  dayHeading: RefObject<HTMLElement | null>;
  startHeading: RefObject<HTMLElement | null>;
}

function lost(doc: Document): boolean {
  const active = doc.activeElement;
  return !active || active === doc.body || !active.isConnected;
}

function toTop(): void {
  (document.scrollingElement ?? document.documentElement).scrollTop = 0;
}

export function usePageFocus({ phase, planId, dayHeading, startHeading }: PageFocusOptions) {
  const [next, setNext] = useState<FocusTarget | null>(null);

  useEffect(() => {
    if (!next) return;
    setNext(null);
    if (next === "plan") {
      // The sheet that had focus just closed; the page is now the trip header and the plan's
      // skeleton, so show it from the top rather than wherever the page was scrolled.
      document.getElementById("plan")?.focus({ preventScroll: true });
      toTop();
    } else if (next === "start") {
      startHeading.current?.focus({ preventScroll: true });
      toTop();
    } else document.querySelector<HTMLElement>('[data-testid="edit-trip-button"]')?.focus();
  }, [next, startHeading]);

  // Decision: after the effect above, so the day heading wins when a plan arrives in the same
  // render as the form is sent. That happens when the tab's plan memo answers at once
  // (lib/planMemo.ts); the traveler then lands where any other new plan puts them.
  useEffect(() => {
    if (planId > 0) dayHeading.current?.focus({ preventScroll: false });
  }, [planId, dayHeading]);

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
