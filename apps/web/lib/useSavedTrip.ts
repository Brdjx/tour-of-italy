"use client";

import type { PlannerContext } from "@italy/planner";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type FetchTrip,
  type LoadedTrip,
  loadSavedTrip,
  openSavedTrip,
  readTripParam,
  type SavedOpen,
  TRIP_PARAM,
} from "./savedTrip";
import { dropParam } from "./useSharedLink";

/** A saved-trip link on its way, and how to give it up. */
export interface SavedTripOnLoad {
  pending: boolean; // a linked trip is still on its way: the page keeps the plan's skeleton
  drop: () => boolean; // gives up a trip that has not opened yet; true when there was one
}

/**
 * Opens a `?t=` saved-trip link: starts fetching the trip at once (it does not need the places),
 * then, once the places are loaded, hands the result to `onOpen` and removes ?t= from the
 * address bar, as useSharedLinkOnLoad does for ?p=. A trip that failed to load keeps ?t=, so a
 * reload tries again. `pending` is true while a linked trip is still on its way, so the page
 * keeps showing the plan's skeleton instead of the form.
 */
// Decision: a fetch that had already failed by the time the places arrived is made once more
// when they do. When the page opened while the API was down, the places failed too and arrive
// only after "Try again", so the first answer is stale by then; when they only took longer, it
// is one more try. A fetch that fails after the places arrived is a fresh answer and is shown.
// Decision: `drop` for a traveler who plans a trip of their own while the link is still on its
// way (the API was down, the form showed, and they planned anyway). Theirs is the newer request,
// so the trip never opens over it, and ?t= goes so a reload does not bring it back either.
export function useSavedTripOnLoad(
  ctx: PlannerContext | null,
  onOpen: (result: SavedOpen) => void,
  fetchTrip?: FetchTrip,
): SavedTripOnLoad {
  const loading = useRef<Promise<LoadedTrip> | null>(null);
  const tripId = useRef<string | null>(null);
  const failedEarly = useRef(false); // the fetch failed before the places were loaded
  const handled = useRef(false);
  const settled = useRef(false); // onOpen was called, or the link was dropped
  const ctxLoaded = useRef(false);
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;
  const [pending, setPending] = useState(false);

  // Decision: read once after hydration, like the other link hooks: the static HTML is the same
  // for every URL.
  useEffect(() => {
    if (loading.current) return;
    const id = readTripParam(window.location.search);
    if (id === null) return;
    setPending(true);
    tripId.current = id;
    loading.current = loadSavedTrip(id, fetchTrip).then((loaded) => {
      if (loaded.kind === "failed" && !ctxLoaded.current) failedEarly.current = true;
      return loaded;
    });
  }, [fetchTrip]);

  // Runs after the effect above in the same commit, so a link read at mount is already loading.
  useEffect(() => {
    const load = loading.current;
    if (ctx) ctxLoaded.current = true;
    if (!ctx || !load || handled.current || settled.current) return;
    handled.current = true;
    const id = tripId.current as string;
    const answer = failedEarly.current ? loadSavedTrip(id, fetchTrip) : load;
    void answer.then((loaded) => {
      if (settled.current) return; // dropped while it loaded
      settled.current = true;
      const result = openSavedTrip(loaded, ctx, new Date().toISOString());
      onOpenRef.current(result);
      setPending(false);
      if (result.status === "invalid" && result.keepLink) return;
      dropParam(TRIP_PARAM);
    });
  }, [ctx, fetchTrip]);

  const drop = useCallback(() => {
    if (loading.current === null || settled.current) return false;
    settled.current = true;
    setPending(false);
    dropParam(TRIP_PARAM);
    return true;
  }, []);

  return { pending, drop };
}
