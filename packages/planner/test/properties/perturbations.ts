import fc from "fast-check";
import { placesOfAnchor } from "../../src/context";
import { addDays } from "../../src/time";
import type { Itinerary, Stop, StopRole } from "../../src/types";
import { anchorIds, ctx } from "./arbitraries";

// Small edits to a valid plan, applied WITHOUT retiming: the kind of drift a buggy client, a
// stale share link, or a tampered request produces. Unlike the validator's mutation tests these
// are not built to always break a rule; many leave the plan valid. The property that uses them
// asserts the validator and the first-principles re-check agree either way.

/** Where and how much to edit. Indexes wrap, so every edit lands somewhere. */
export interface Edit {
  kind: number; // index into EDITS
  day: number;
  stop: number;
  n: number; // a second index (another day, a place, a role)
  delta: number; // minutes, never 0
}

export const anyEdit: fc.Arbitrary<Edit> = fc.record({
  kind: fc.nat(),
  day: fc.nat(),
  stop: fc.nat(),
  n: fc.nat(),
  delta: fc.oneof(fc.integer({ min: -120, max: -1 }), fc.integer({ min: 1, max: 120 })),
});

const ROLES: readonly StopRole[] = ["visit", "lunch", "dinner"];

/** The stop an edit points at, or null when the day is empty. */
function target(plan: Itinerary, edit: Edit): { stops: Stop[]; index: number; stop: Stop } | null {
  const day = plan.days[edit.day % plan.days.length];
  if (!day || day.stops.length === 0) return null;
  const index = edit.stop % day.stops.length;
  const stop = day.stops[index];
  return stop ? { stops: day.stops, index, stop } : null;
}

type Apply = (plan: Itinerary, edit: Edit) => void;

/** Each edit changes the plan in place. Named so a failing counterexample reads clearly. */
export const EDITS: Record<string, Apply> = {
  shiftStop: (plan, edit) => {
    const at = target(plan, edit);
    if (!at) return;
    at.stop.start += edit.delta;
    at.stop.end += edit.delta;
  },
  stretchStop: (plan, edit) => {
    const at = target(plan, edit);
    if (at) at.stop.end += edit.delta;
  },
  changeRole: (plan, edit) => {
    const at = target(plan, edit);
    if (at) at.stop.role = ROLES[edit.n % ROLES.length] ?? "visit";
  },
  swapNeighbours: (plan, edit) => {
    const at = target(plan, edit);
    const next = at?.stops[at.index + 1];
    if (!at || !next) return;
    [at.stop.placeId, next.placeId] = [next.placeId, at.stop.placeId];
  },
  moveToAnotherDay: (plan, edit) => {
    const at = target(plan, edit);
    const other = plan.days[(edit.day + 1 + (edit.n % 2)) % plan.days.length];
    if (!at || !other) return;
    at.stops.splice(at.index, 1);
    other.stops.push(at.stop);
    other.stops.sort((a, b) => a.start - b.start);
  },
  claimTransfer: (plan, edit) => {
    const day = plan.days[edit.day % plan.days.length];
    if (day) day.transferMin = Math.max(0, day.transferMin + edit.delta);
  },
  claimTravel: (plan, edit) => {
    const at = target(plan, edit);
    if (at) at.stop.travelFromPrevMin = Math.max(0, at.stop.travelFromPrevMin + edit.delta);
  },
  replacePlace: (plan, edit) => {
    const at = target(plan, edit);
    const day = plan.days[edit.day % plan.days.length];
    const pool = day ? placesOfAnchor(ctx, day.anchorId) : [];
    const place = pool[edit.n % Math.max(1, pool.length)];
    if (at && place) at.stop.placeId = place.id;
  },
  changeBase: (plan, edit) => {
    const day = plan.days[edit.day % plan.days.length];
    if (day) day.anchorId = anchorIds[edit.n % anchorIds.length] ?? day.anchorId;
  },
  changeDate: (plan, edit) => {
    const day = plan.days[edit.day % plan.days.length];
    if (day) day.date = addDays(day.date, edit.delta > 0 ? 1 : -1);
  },
  removeStop: (plan, edit) => {
    const at = target(plan, edit);
    if (at) at.stops.splice(at.index, 1);
  },
  excludeStop: (plan, edit) => {
    const at = target(plan, edit);
    if (at && !plan.request.mustInclude.includes(at.stop.placeId)) {
      plan.request.exclude.push(at.stop.placeId);
    }
  },
};

export const EDIT_NAMES: readonly string[] = Object.keys(EDITS);

/** A deep copy of the plan with the edits applied in order. */
export function applyEdits(plan: Itinerary, edits: readonly Edit[]): Itinerary {
  const copy = structuredClone(plan);
  for (const edit of edits) {
    const name = EDIT_NAMES[edit.kind % EDIT_NAMES.length] ?? "";
    EDITS[name]?.(copy, edit);
  }
  return copy;
}

/** The edit names, in order, for a readable failure message. */
export function editNames(edits: readonly Edit[]): string[] {
  return edits.map((edit) => EDIT_NAMES[edit.kind % EDIT_NAMES.length] ?? "?");
}
