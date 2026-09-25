"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { EXPECT_PLAN_ATTR } from "./expectPlanScript";
import { browserStore, hasStoredPlan, type KeyValueStore } from "./lastPlan";
import { readTripParam } from "./savedTrip";
import { readShareParam } from "./shareLink";

// Whether a plan is about to appear on its own: the page was opened with a shared or saved-trip
// link, or a plan is saved from the last visit. Both need the places before they can be checked and shown,
// so until then the page shows the plan's skeleton rather than the form, and a traveler opening
// a link never sees the empty form flash up first.

/**
 * True from the first render in the browser until the places have loaded (or failed to load).
 * Call it after useLastPlan and useSharedLinkOnLoad: its effect then runs after theirs, so the
 * restored or shared plan and the end of the wait land in the same render, with no frame of the
 * empty form between them.
 */
export function usePlanExpected(
  settled: boolean,
  store: () => KeyValueStore | null = browserStore,
): boolean {
  const [expected, setExpected] = useState(false);
  const storeRef = useRef(store);
  storeRef.current = store;

  // Decision: read after hydration, not during render: the static HTML is the same for every
  // URL. A layout effect re-renders before the browser paints, so the skeleton replaces the
  // page the head script held back (lib/expectPlanScript.ts) in the same frame.
  useLayoutEffect(() => {
    const search = window.location.search;
    const linked = readShareParam(search) !== null || readTripParam(search) !== null;
    setExpected(linked || hasStoredPlan(storeRef.current()));
    document.documentElement.removeAttribute(EXPECT_PLAN_ATTR);
  }, []);

  useEffect(() => {
    if (settled) setExpected(false);
  }, [settled]);

  return expected;
}
