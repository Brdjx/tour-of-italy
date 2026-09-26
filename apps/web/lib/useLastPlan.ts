"use client";

import type { Itinerary, PlannerContext } from "@italy/planner";
import { useCallback, useEffect, useRef } from "react";
import type { DayMade } from "./dayCity";
import { type ItineraryState, isEdited, type PlanOrigin } from "./itineraryReducer";
import { browserStore, forget, type KeyValueStore, readLastPlan, saveLastPlan } from "./lastPlan";
import type { FallbackCause } from "./planRequest";
import { readTripParam, type SavedTrip } from "./savedTrip";
import { readShareParam } from "./shareLink";

// Brings the last plan back when the app opens, saves the plan after every change, and forgets
// it when the traveler starts a new trip.

export interface RestoredPlan {
  itinerary: Itinerary;
  origin: PlanOrigin;
  cause: FallbackCause | null;
  saved: SavedTrip | null;
  edited: boolean; // the traveler had changed it on this device before the reload
  dayMade: (DayMade | null)[]; // how each day was planned again, null for as the plan came
  flagged: number; // stops that break a rule with the current data
}

export interface LastPlanOptions {
  store?: () => KeyValueStore | null; // injected in tests
  now?: () => Date;
}

/**
 * Once the places are loaded, restores the saved plan through `onRestore`, unless the page was
 * opened with a shared or saved-trip link or already has a plan. Every later plan or edit is
 * saved. Call it before useSharedLinkOnLoad and useSavedTripOnLoad: they remove ?p= and ?t= from
 * the address bar.
 * Returns `forgetLastPlan`, which removes the saved plan ("Start a new trip").
 */
export function useLastPlan(
  ctx: PlannerContext | null,
  plan: Pick<
    ItineraryState,
    "itinerary" | "origin" | "cause" | "saved" | "history" | "editedBefore" | "dayMade"
  >,
  onRestore: (restored: RestoredPlan) => void,
  options: LastPlanOptions = {},
): () => void {
  const latest = useRef({ plan, onRestore, options });
  latest.current = { plan, onRestore, options };
  const openedWithLink = useRef<boolean | null>(null);
  const checked = useRef(false);
  const restored = useRef<Itinerary | null>(null);

  useEffect(() => {
    // Read on the first run, before the link hooks strip ?p= or ?t= from the address bar.
    openedWithLink.current ??=
      readShareParam(window.location.search) !== null ||
      readTripParam(window.location.search) !== null;
    if (!ctx || checked.current) return;
    checked.current = true;
    const { plan: current, options: opts } = latest.current;
    // Decision: a shared or saved-trip link is what the traveler asked to open, so it wins over
    // the plan kept on this device.
    if (openedWithLink.current || current.itinerary) return;
    const store = (opts.store ?? browserStore)();
    if (!store) return;
    const result = readLastPlan(store, ctx, (opts.now ?? (() => new Date()))());
    if (result.status !== "restored") return;
    restored.current = result.itinerary;
    latest.current.onRestore(result);
  }, [ctx]);

  const edited = isEdited(plan);
  useEffect(() => {
    // The restored plan is already stored; saving it again would only refresh its age.
    if (!plan.itinerary || plan.itinerary === restored.current) return;
    const opts = latest.current.options;
    const store = (opts.store ?? browserStore)();
    const now = (opts.now ?? (() => new Date()))();
    const extra = { cause: plan.cause, saved: plan.saved, edited, dayMade: plan.dayMade };
    if (store) saveLastPlan(store, plan.itinerary, plan.origin, now, extra);
  }, [plan.itinerary, plan.origin, plan.cause, plan.saved, edited, plan.dayMade]);

  // Decision: the page clears its plan in the same step, so nothing is saved again after this;
  // the next plan the traveler makes is saved as usual.
  return useCallback(() => {
    const store = (latest.current.options.store ?? browserStore)();
    if (store) forget(store);
    restored.current = null;
  }, []);
}
