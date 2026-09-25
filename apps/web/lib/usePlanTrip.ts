"use client";

import type { PlannerContext, TripRequest } from "@italy/planner";
import { useEffect, useRef, useState } from "react";
import { describeApiError, isApiError, isRequestProblem } from "./apiError";
import type { ItineraryAction } from "./itineraryReducer";
import { PlanMemo } from "./planMemo";
import { type PlanDeps, type PlanOutcome, requestPlan } from "./planRequest";

// The plan request as page state: idle, planning (with the request, for the trip summary), or
// failed with a message. A newer request cancels the one in flight; a failure keeps the
// previous plan. A request still running after SLOW_PLAN_MS says so, honestly. Options this tab
// already had an AI plan for are shown at once from the tab's plan memo (lib/planMemo.ts).

export type PlanPhase =
  | { kind: "idle" }
  | { kind: "planning"; request: TripRequest; slow: boolean }
  | { kind: "error"; message: string; retry: boolean };

/** When a plan that is still on its way gets the "Still working" line. */
// Decision: 8 s. The AI path usually answers in 3 to 6 s; past 8 s the traveler starts to
// wonder, and the server falls back to rules at its own deadline, which the line promises.
export const SLOW_PLAN_MS = 8000;
export const SLOW_PLAN_TEXT =
  "Still working. If the AI planner takes too long, the plan is built with rules.";

interface PlanTripOptions {
  ctx: PlannerContext | null;
  post?: PlanDeps["post"];
  dispatch: (action: ItineraryAction) => void;
  announce: (text: string) => void;
  onPlanned: () => void;
}

/** The live-region sentence for a new plan. */
export function readyMessage(outcome: PlanOutcome): string {
  if (outcome.kind === "api") return "Your plan is ready.";
  if (outcome.cause === "offline") return "Your plan is ready. It was planned without AI, offline.";
  return "Your plan is ready. It was planned on this device, without AI.";
}

export function usePlanTrip({ ctx, post, dispatch, announce, onPlanned }: PlanTripOptions) {
  const [phase, setPhase] = useState<PlanPhase>({ kind: "idle" });
  const controller = useRef<AbortController | null>(null);
  const lastRequest = useRef<TripRequest | null>(null);
  const slowTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Decision: the places are read when the answer arrives, not when the button was pressed.
  // "Plan my trip" works before they load, and they almost always arrive while the plan is on
  // its way, so the browser can still check the plan (and fall back to planning here).
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  const memoRef = useRef<PlanMemo | null>(null);
  memoRef.current ??= new PlanMemo();
  const memo = memoRef.current;

  useEffect(() => () => clearTimeout(slowTimer.current), []);

  const planTrip = async (request: TripRequest) => {
    controller.current?.abort();
    clearTimeout(slowTimer.current);
    lastRequest.current = request;
    const deterministic =
      new URLSearchParams(window.location.search).get("mode") === "deterministic";
    // Decision: a plan from the memo is shown with the same source line and the same "Your plan
    // is ready", and no note such as "Shown from this session". It is the very plan the API
    // returned for these options, the API would answer with it again from its own cache, and a
    // note would suggest it differs or is stale when neither is true.
    const known = deterministic ? undefined : memo.get(request);
    if (known) {
      controller.current = null;
      const message = readyMessage({ kind: "api", itinerary: known });
      dispatch({ type: "plan", itinerary: known, origin: "api", message });
      setPhase({ kind: "idle" });
      onPlanned();
      return;
    }
    const current = new AbortController();
    controller.current = current;
    setPhase({ kind: "planning", request, slow: false });
    announce("Planning your trip.");
    slowTimer.current = setTimeout(() => {
      setPhase((now) => (now.kind === "planning" ? { ...now, slow: true } : now));
      announce(SLOW_PLAN_TEXT);
    }, SLOW_PLAN_MS);
    const deps: PlanDeps = {
      get ctx() {
        return ctxRef.current;
      },
      post,
    };
    try {
      const outcome = await requestPlan(request, deps, { signal: current.signal, deterministic });
      if (current.signal.aborted) return;
      clearTimeout(slowTimer.current);
      // Kept only once this browser has checked it (requestPlan does when the places are loaded).
      if (outcome.kind === "api" && !deterministic && ctxRef.current) {
        memo.set(request, outcome.itinerary);
      }
      dispatch({
        type: "plan",
        itinerary: outcome.itinerary,
        origin: outcome.kind,
        cause: outcome.kind === "offline" ? outcome.cause : null,
        message: readyMessage(outcome),
      });
      setPhase({ kind: "idle" });
      onPlanned();
    } catch (error) {
      if (current.signal.aborted || (isApiError(error) && error.kind === "aborted")) return;
      clearTimeout(slowTimer.current);
      // Decision: no "Try again" for a request the API refused; sending it again cannot help,
      // and the message already says which field to check.
      setPhase({
        kind: "error",
        message: describeApiError(error),
        retry: !isRequestProblem(error),
      });
    }
  };

  const retry =
    phase.kind === "error" && phase.retry
      ? () => {
          if (lastRequest.current) void planTrip(lastRequest.current);
        }
      : undefined;

  return { phase, planTrip, retry };
}
