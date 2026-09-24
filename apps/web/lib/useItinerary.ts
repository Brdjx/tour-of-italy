"use client";

import type { PlannerContext } from "@italy/planner";
import { useReducer } from "react";
import {
  type ItineraryAction,
  type ItineraryState,
  initialItineraryState,
  itineraryReducer,
} from "./itineraryReducer";

/** The itinerary reducer bound to the loaded places. */
export function useItinerary(ctx: PlannerContext | null) {
  // Decision: the reducer closes over the current context instead of carrying it in every
  // action. React uses the reducer from the latest render, so edits always see loaded places.
  return useReducer(
    (state: ItineraryState, action: ItineraryAction) => itineraryReducer(state, action, ctx),
    undefined,
    initialItineraryState,
  );
}
