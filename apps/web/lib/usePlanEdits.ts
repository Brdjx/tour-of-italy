"use client";

import { useEffect, useRef, useState } from "react";
import type { EditIntent } from "./editFocus";
import type { ItineraryAction, ItineraryState } from "./itineraryReducer";

// Edits to the plan on screen (swap, remove, move, days planned again, undo) as page actions:
// each one tells the focus keeper where focus should land, stops the draw-in animation, and marks
// the next status message as coming from an edit, so it shows in the toast with Undo as well as
// being announced.

export interface StopTarget {
  day: number;
  stop: number;
}

interface PlanEditsOptions {
  plan: ItineraryState;
  dispatch: (action: ItineraryAction) => void;
  announce: (text: string, edit?: boolean) => void;
  expectFocus: (intent: EditIntent) => void;
  showDay: (day: number) => void; // select a day's tab
  onEdit: () => void; // runs before each edit (the page stops the draw-in animation)
}

export function usePlanEdits(options: PlanEditsOptions) {
  const { plan, dispatch, announce, expectFocus, showDay, onEdit } = options;
  const [swapping, setSwapping] = useState<StopTarget | null>(null);
  const editPending = useRef(false);

  // Every reducer result carries a status sentence; announce it once per state change.
  useEffect(() => {
    if (!plan.message) return;
    announce(plan.message, editPending.current);
    editPending.current = false;
  }, [plan, announce]);

  const edit = (action: ItineraryAction) => {
    editPending.current = true;
    onEdit();
    dispatch(action);
  };

  const undo = () => {
    // Show the day the undone edit was on, so the traveler sees what came back.
    const last = plan.history.at(-1);
    if (last) showDay(last.at.day);
    expectFocus({ type: "undo", planId: plan.planId });
    edit({ type: "undo" });
  };

  const remove = (day: number, stop: number) => {
    const placeId = plan.itinerary?.days[day]?.stops[stop]?.placeId ?? "";
    expectFocus({ type: "remove", planId: plan.planId, day, stop, placeId });
    edit({ type: "remove", day, stop });
  };

  const move = (day: number, stop: number, direction: "up" | "down") => {
    expectFocus({ type: "move", planId: plan.planId });
    edit({ type: "move", day, stop, direction });
  };

  const chooseSwap = (placeId: string) => {
    if (!swapping) return;
    edit({ type: "swap", day: swapping.day, stop: swapping.stop, placeId });
    setSwapping(null);
  };

  // Days planned again (lib/useDayRoute.ts). Focus stays where the traveler is: on the heading
  // of the first day planned, where the route sheet left it, or wherever they went meanwhile.
  // Decision: the draw-in is left as the run set it, since each day's rows already arrived with
  // the split-flap as the run planned it; stopping it here would slide the board in again.
  const applyReplan = (action: Extract<ItineraryAction, { type: "replan" }>) => {
    editPending.current = true;
    dispatch(action);
  };

  return {
    applyReplan,
    swapping,
    startSwap: (day: number, stop: number) => setSwapping({ day, stop }),
    cancelSwap: () => setSwapping(null),
    chooseSwap,
    undo,
    remove,
    move,
  };
}
