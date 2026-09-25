import type { LogFields } from "../lib/logger";
import type { RandomSource } from "./ids";
import { type AiItinerary, planRecordFrom } from "./records";
import { expiresAtFrom, KEEP_SECONDS, STORE_TIMEOUT_MS, saveNew, type TripStore } from "./store";

// POST /api/plan keeps the AI content of every AI plan it returns, under a new planId on the
// itinerary. Saving the trip later sends that planId back, and the saved trip then carries the
// AI's why lines and summary from this record, never from the browser.

export interface KeepPlanDeps {
  store: TripStore | null; // null when saved trips are off
  now: () => number;
  random?: RandomSource;
}

/**
 * Stores the plan's AI content and sets itinerary.planId. Records the outcome on the log line.
 * Never throws and never waits longer than STORE_TIMEOUT_MS.plan.
 */
// Decision: a plan never fails, and never waits more than that limit, because its record could
// not be kept. It goes out without a planId; saving it as a trip then works, with rule why lines.
export async function keepAiPlan(
  itinerary: AiItinerary,
  deps: KeepPlanDeps,
  fields: LogFields,
): Promise<void> {
  if (!deps.store) return;
  try {
    const text = JSON.stringify(planRecordFrom(itinerary, new Date(deps.now()).toISOString()));
    itinerary.planId = await saveNew(deps.store, () => text, {
      prefix: "plan",
      expiresAt: expiresAtFrom(deps.now(), KEEP_SECONDS.plan),
      timeoutMs: STORE_TIMEOUT_MS.plan,
      random: deps.random,
    });
    fields.tripStore = "ok";
  } catch (error) {
    fields.tripStore = "error";
    fields.storeError = error;
  }
}
