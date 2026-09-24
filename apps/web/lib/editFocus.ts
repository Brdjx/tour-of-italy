"use client";

import { type RefObject, useCallback, useEffect, useRef } from "react";
import type { ItineraryState } from "./itineraryReducer";

// Where keyboard focus goes after an edit, so it is never dropped to the page or left
// off screen. Runs after React has committed the edited plan:
// - move: the moved row's button keeps focus (React keeps the element); it is scrolled into view.
// - remove: focus moves to the Swap button of the row that took its place (or the new last row).
// - undo: when the Undo control disappeared with the last history entry, focus goes to the Swap
//   button of the row that came back.
// Scrolling uses block "nearest", and html's scroll-padding keeps the target clear of the
// pinned day tabs, the sticky form bar and the toast.

export type EditIntent =
  | { type: "move"; planId: number }
  | { type: "remove"; planId: number; day: number; stop: number; placeId: string }
  | { type: "undo"; planId: number };

type PlanView = Pick<ItineraryState, "itinerary" | "changed" | "planId">;

export function swapButtonSelector(day: number, stop: number): string {
  return `#stop-${day}-${stop} [data-testid="swap-button"]`;
}

/** True when nothing useful has focus: the body, nothing, or an element that was removed. */
export function focusLost(doc: Document): boolean {
  const active = doc.activeElement;
  return active === null || active === doc.body || !active.isConnected;
}

function reveal(element: Element | null): void {
  element?.scrollIntoView?.({ block: "nearest" });
}

function focusAndReveal(element: HTMLElement | null): boolean {
  if (!element) return false;
  element.focus({ preventScroll: true });
  reveal(element);
  return true;
}

/** Applies the focus rule for `intent` to the committed `plan`. */
export function focusAfterEdit(
  intent: EditIntent,
  plan: PlanView,
  fallback: HTMLElement | null,
  doc: Document = document,
): void {
  if (intent.planId !== plan.planId) return; // a new plan arrived; it handles its own focus
  if (intent.type === "move") {
    if (!focusLost(doc)) reveal(doc.activeElement);
    return;
  }
  if (intent.type === "remove") {
    const stops = plan.itinerary?.days[intent.day]?.stops ?? [];
    // A refused remove (a day's only stop) leaves the row, and its focused button, in place.
    if (stops.some((stop) => stop.placeId === intent.placeId)) return;
    const next = Math.min(intent.stop, stops.length - 1);
    const target = doc.querySelector<HTMLElement>(swapButtonSelector(intent.day, next));
    if (!focusAndReveal(target)) focusAndReveal(fallback);
    return;
  }
  if (!focusLost(doc)) return;
  const at = plan.changed;
  const target = at ? doc.querySelector<HTMLElement>(swapButtonSelector(at.day, at.stop)) : null;
  if (!focusAndReveal(target)) focusAndReveal(fallback);
}

/**
 * Remembers the focus rule for the edit about to be dispatched and applies it once the edited
 * plan is on screen. `fallback` (the day heading) is used when the target row is not shown.
 */
export function useEditFocus(
  plan: PlanView,
  fallback: RefObject<HTMLElement | null>,
): (intent: EditIntent) => void {
  const pending = useRef<EditIntent | null>(null);
  useEffect(() => {
    const intent = pending.current;
    pending.current = null;
    if (intent) focusAfterEdit(intent, plan, fallback.current);
  }, [plan, fallback]);
  return useCallback((intent: EditIntent) => {
    pending.current = intent;
  }, []);
}
