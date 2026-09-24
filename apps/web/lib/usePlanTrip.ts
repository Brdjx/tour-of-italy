"use client";

import type { PlannerContext, TripRequest } from "@italy/planner";
import { useRef, useState } from "react";
import { describeApiError, isApiError, isRequestProblem } from "./apiError";
import type { ItineraryAction } from "./itineraryReducer";
import { type PlanDeps, type PlanOutcome, requestPlan } from "./planRequest";

// The plan request as page state: idle, planning, or failed with a message. A newer request
// cancels the one in flight; a failure keeps the previous plan on screen.

export type PlanPhase =
  | { kind: "idle" }
  | { kind: "planning" }
  | { kind: "error"; message: string; retry: boolean };

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

  const planTrip = async (request: TripRequest) => {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    lastRequest.current = request;
    setPhase({ kind: "planning" });
    announce("Planning your trip.");
    const deterministic =
      new URLSearchParams(window.location.search).get("mode") === "deterministic";
    try {
      const outcome = await requestPlan(
        request,
        { ctx, post },
        { signal: current.signal, deterministic },
      );
      if (current.signal.aborted) return;
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
