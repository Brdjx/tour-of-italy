import type { FallbackReason } from "@italy/planner";
import { errorKindOf, fallbackReasonFor, type RetryPolicy, retryPauseMs } from "../llm/errors";
import { type PlanTrace, recordFailure } from "./outcome";

// One model turn with its time budget, shared by the whole-trip pipeline (planTrip.ts) and the
// one-day pipeline (replanDay.ts): each call gets what the deadline leaves after the reserve, and
// a brief failure gets one retry when time allows.

export interface PlanTiming {
  reserveMs: number; // time kept back for the fallback plan and the response
  minCallMs: number; // a first call is not started with less time than this
  minRepairMs: number; // a repair is not started with less time than this
  retry: RetryPolicy; // the pause before retrying a brief failure, and the longest wait allowed
}

// Decision: 1.5 s reserve (the fallback plans in about 10 ms, the rest is margin for a slow cold
// instance), no call under 2 s, and no repair under 4 s: a repair that cannot finish only burns
// tokens and delays the fallback. A retry waits 0.4 s, or the API's retry-after up to 1 s.
export const DEFAULT_TIMING: PlanTiming = {
  reserveMs: 1500,
  minCallMs: 2000,
  minRepairMs: 4000,
  retry: { defaultPauseMs: 400, maxPauseMs: 1000 },
};

/** The clock, the time limits, and the trace one run of a pipeline shares. */
export interface TurnRun {
  deps: {
    now: () => number;
    config: { timeoutMs: number; deadlineMs: number };
    timing?: PlanTiming;
  };
  startedAt: number;
  trace: PlanTrace;
}

/** What went wrong with an answer: it was off the schema, or it failed the check. */
export type ProblemKind = "schema" | "invalid";

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Why the model path gave up with a problem still in hand. */
// Decision: an answer that was repaired and still failed is invalid_after_repair; an off-schema
// answer that never got a repair is schema_invalid; a bad plan that had no time left for its
// repair is timeout, because time, not the model, is what stopped the fix.
export function giveUpReason(
  kind: ProblemKind,
  repaired: boolean,
  outOfTime: boolean,
): FallbackReason {
  if (repaired) return "invalid_after_repair";
  if (kind === "schema") return "schema_invalid";
  return outOfTime ? "timeout" : "invalid_after_repair";
}

/**
 * One model turn (first answer or repair) made by `ask`, with one retry of a brief failure when
 * time allows. Returns the result, or the fallback reason when the turn failed or there was no
 * time for it.
 */
// Decision: each call gets the configured timeout (15 s) or what is left of the deadline after
// the reserve, whichever is less. The first call starts with 22.5 s left, so it gets the full
// 15 s; a repair gets what remains, which stays over its 4 s minimum even after a first answer
// at 15 s (24 - 15 - 1.5 = 7.5 s). Live repairs on 2026-09-25 took 2.6 to 8.0 s, and one ran
// past its 12 s limit, so a slow repair after one of the slowest first answers can still run out
// and fall back.
export async function runTurn<R>(
  run: TurnRun,
  floorMs: number,
  state: { retried: boolean },
  ask: (timeoutMs: number) => Promise<R>,
): Promise<R | { giveUp: FallbackReason | "no_time" }> {
  const { deps, trace } = run;
  const timing = deps.timing ?? DEFAULT_TIMING;
  const timeLeft = () => run.startedAt + deps.config.deadlineMs - deps.now() - timing.reserveMs;
  for (;;) {
    const timeoutMs = Math.min(deps.config.timeoutMs, timeLeft());
    if (timeoutMs < floorMs) return { giveUp: "no_time" };
    trace.attempts++;
    try {
      return await ask(timeoutMs);
    } catch (error) {
      recordFailure(trace, error);
      const wait = state.retried ? null : retryPauseMs(error, timing.retry);
      if (wait === null || timeLeft() - wait < floorMs) {
        return { giveUp: fallbackReasonFor(errorKindOf(error)) };
      }
      state.retried = true;
      await pause(wait);
    }
  }
}
