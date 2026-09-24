// Tunables for the deterministic planner (scheduleDay, planDeterministic, swap alternatives).
// Data and travel tunables live in config.ts; these only shape how the greedy planner walks a
// day and chooses bases. Change a value, run `pnpm check`, and the scheduler tests show what moved.

/**
 * A stop that can start within this many minutes of arriving counts as "available now". The
 * greedy walk prefers available stops and only waits longer when nothing else can happen.
 */
// Decision: 30 minutes. Shorter makes lunch at 12:00 lose to a visit that ends at 12:40 and a
// long wait later; longer lets a meal or a late-opening museum idle the traveler for an hour.
export const MAX_IDLE_MIN = 30;

/**
 * A meal place reached when it could also be visited takes a meal role only if that meal can
 * start within this many minutes of the visit's start (see inferRole).
 */
// Decision: 60 minutes. A market reached at 09:45 is a morning visit, not a lunch two hours
// later; a restaurant reached at 11:30 is lunch at 12:00; a must-include restaurant after the
// day's lunch and dinner are taken can still be an afternoon visit.
export const MEAL_WAIT_MAX_MIN = 60;

/**
 * When the planner chooses bases itself, it compares full trips for this many of the
 * highest-ranked bases (each alone, and each pair in both orders and every day split).
 */
// Decision: 3 of the 5 bases. Bases holding must-include places always rank first, so this never
// hides one; the remaining bases are only tried when no shortlisted trip can fill every day.
export const ANCHOR_SHORTLIST = 3;

/** Default meta.generatedAt when the caller injects no clock. Fixed so output is reproducible. */
// Decision: the Unix epoch rather than Date.now(). The planner is pure; the API passes a clock.
export const EPOCH_ISO = "1970-01-01T00:00:00.000Z";
