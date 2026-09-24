import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MEALS, PACE, TRAVEL } from "../../src/config";
import { addDays, openStatusOn } from "../../src/time";
import { travelMinutes } from "../../src/travel";
import type { Itinerary, Stop, ViolationCode } from "../../src/types";
import { validateItinerary } from "../../src/validate";
import { FC_SETTINGS } from "../plannerFixtures";
import { ctx, VALID_TRIPS } from "./fixtures";

// Failure vector F1, property half: fast-check picks a valid trip, a kind of corruption, and
// where to apply it, then asserts the corruption's own error code appears. Each kind is built so
// it is ALWAYS a real corruption (never a no-op), so a pass means the validator caught it.

type Pick = { trip: number; day: number; stop: number; n: number; m: number };
type Corrupt = (plan: Itinerary, pick: Pick) => ViolationCode | null;

/** The stop a pick points at, wrapping indices so every pick lands somewhere. */
function locate(plan: Itinerary, pick: Pick): { day: number; index: number; stop: Stop } | null {
  const day = pick.day % plan.days.length;
  const stops = plan.days[day]?.stops ?? [];
  if (stops.length === 0) return null;
  const index = pick.stop % stops.length;
  const stop = stops[index];
  return stop ? { day, index, stop } : null;
}

function setStart(stop: Stop, start: number): void {
  stop.end = start + (stop.end - stop.start);
  stop.start = start;
}

const place = (id: string) => ctx().placesById.get(id);

// Each kind returns the code it must cause, or null when the pick does not apply (skipped).
const KINDS: Record<string, Corrupt> = {
  unknownPlace: (plan, pick) => {
    const at = locate(plan, pick);
    if (!at) return null;
    at.stop.placeId = `zz_invented_${pick.n}`;
    return "UNKNOWN_PLACE";
  },
  duplicate: (plan, pick) => {
    const all = plan.days.flatMap((d) => d.stops);
    const from = all[pick.n % all.length];
    const to = all[(pick.n + 1 + (pick.m % (all.length - 1))) % all.length];
    if (!from || !to || from === to) return null;
    to.placeId = from.placeId;
    return "DUPLICATE_PLACE";
  },
  exclude: (plan, pick) => {
    const at = locate(plan, pick);
    if (!at) return null;
    plan.request.exclude.push(at.stop.placeId);
    return "EXCLUDED_PLACE";
  },
  emptyDay: (plan, pick) => {
    const day = plan.days[pick.day % plan.days.length];
    if (!day) return null;
    day.stops = [];
    return "EMPTY_DAY";
  },
  dayCount: (plan, pick) => {
    const index = pick.day % plan.days.length;
    if (pick.n % 2 === 0) plan.days.splice(index, 1);
    else plan.days.push(structuredClone(plan.days[index] as Itinerary["days"][number]));
    return "WRONG_DAY_COUNT";
  },
  overlap: (plan, pick) => {
    const at = locate(plan, pick);
    const prev = at && at.index > 0 ? plan.days[at.day]?.stops[at.index - 1] : undefined;
    const a = prev && place(prev.placeId);
    const b = at && place(at.stop.placeId);
    if (!at || !prev || !a || !b) return null;
    // any start before prev.end + travel + buffer, from prev.start up
    const room = prev.end - prev.start + travelMinutes(a, b) + TRAVEL.bufferMin;
    setStart(at.stop, prev.start + (pick.n % room));
    return "OVERLAP";
  },
  mealWindow: (plan, pick) => {
    const meals = plan.days.flatMap((d) => d.stops).filter((s) => s.role !== "visit");
    const meal = meals[pick.n % meals.length];
    if (!meal || meal.role === "visit") return null;
    const { earliestStart, latestStart } = MEALS[meal.role];
    const early = pick.m % earliestStart; // 00:00 up to a minute before the window
    const late = latestStart + 1 + (pick.m % 240); // a minute after, up to 4 h after
    setStart(meal, pick.n % 2 === 0 ? early : late);
    return "MEAL_OUTSIDE_WINDOW";
  },
  badTime: (plan, pick) => {
    const at = locate(plan, pick);
    if (!at) return null;
    const variants = [
      () => (at.stop.start += 0.25 + (pick.m % 3) / 4),
      () => (at.stop.end = at.stop.start - (pick.m % 120)),
      () => (at.stop.end += 1 + (pick.m % 60)),
      () => (at.stop.end -= 1 + (pick.m % 14)),
      () => (at.stop.start = Number.NaN),
    ];
    variants[pick.n % variants.length]?.();
    return "INVALID_TIME";
  },
  crossBase: (plan, pick) => {
    const at = locate(plan, pick);
    const anchorId = at && plan.days[at.day]?.anchorId;
    const others = ctx().places.filter((p) => ctx().anchorIdByPlaceId.get(p.id) !== anchorId);
    const other = others[pick.n % others.length];
    if (!at || !other) return null;
    at.stop.placeId = other.id;
    return "OUTSIDE_ANCHOR";
  },
  unknownAnchor: (plan, pick) => {
    const day = plan.days[pick.day % plan.days.length];
    if (!day) return null;
    day.anchorId = `zz_base_${pick.n}`;
    return "UNKNOWN_ANCHOR";
  },
  wrongDate: (plan, pick) => {
    const day = plan.days[pick.day % plan.days.length];
    if (!day) return null;
    day.date = addDays(day.date, pick.n % 2 === 0 ? 1 + (pick.m % 400) : -1 - (pick.m % 400));
    return "WRONG_DATE";
  },
  wrongTransfer: (plan, pick) => {
    const day = plan.days[pick.day % plan.days.length];
    if (!day) return null;
    day.transferMin += pick.n % 2 === 0 ? 5 + (pick.m % 300) : -5 - (pick.m % 300);
    return "WRONG_TRAVEL";
  },
  wrongTravel: (plan, pick) => {
    const at = locate(plan, pick);
    if (!at) return null;
    at.stop.travelFromPrevMin += pick.n % 2 === 0 ? 1 + (pick.m % 90) : -1 - (pick.m % 90);
    return "WRONG_TRAVEL";
  },
  closedHours: (plan, pick) => {
    const at = locate(plan, pick);
    const found = at && place(at.stop.placeId);
    const date = at && plan.days[at.day]?.date;
    if (!at || !found || !date) return null;
    const status = openStatusOn(found, date);
    if (status.state !== "open") return null;
    const range = status.ranges[pick.m % status.ranges.length];
    const length = at.stop.end - at.stop.start;
    if (!range) return null;
    setStart(at.stop, range.close - length + 1 + (pick.n % (length - 1))); // runs past closing
    return "CLOSED_AT_TIME";
  },
  dropMustInclude: (plan, pick) => {
    const must = plan.request.mustInclude;
    const days = plan.days.filter((d) => d.stops.some((s) => must.includes(s.placeId)));
    const day = days[pick.n % Math.max(days.length, 1)];
    if (!day) return null;
    day.stops = day.stops.filter((s) => !must.includes(s.placeId));
    return "MUST_INCLUDE_MISSING";
  },
  overCap: (plan, pick) => {
    const cap = PACE[plan.request.pace].maxVisits;
    const day = plan.days.find((d, i) => i >= pick.day % plan.days.length && d.stops.length > cap);
    if (!day) return null;
    for (const s of day.stops) s.role = "visit";
    return "TOO_MANY_VISITS";
  },
};

const KIND_NAMES = Object.keys(KINDS);

const pickArb = fc.record({
  trip: fc.nat({ max: VALID_TRIPS.length - 1 }),
  day: fc.nat({ max: 20 }),
  stop: fc.nat({ max: 20 }),
  n: fc.nat({ max: 10_000 }),
  m: fc.nat({ max: 10_000 }),
});

describe("random single corruptions of valid trips", () => {
  it("always raises the corruption's own error code", () => {
    const applied = new Map<string, number>();
    fc.assert(
      fc.property(fc.constantFrom(...KIND_NAMES), pickArb, (kind, pick) => {
        const plan = (VALID_TRIPS[pick.trip] ?? VALID_TRIPS[0])?.build() as Itinerary;
        const expected = KINDS[kind]?.(plan, pick) ?? null;
        if (expected === null) return; // the pick did not apply to this trip
        applied.set(kind, (applied.get(kind) ?? 0) + 1);
        const errors = validateItinerary(plan, ctx()).filter((v) => v.severity === "error");
        expect(errors.map((v) => v.code)).toContain(expected);
      }),
      { ...FC_SETTINGS, numRuns: Math.max(FC_SETTINGS.numRuns, 300) },
    );
    // Decision: every kind must have applied at least once, or the property could pass while
    // testing nothing for that kind (for example if a fixture change made it always skip).
    expect(KIND_NAMES.filter((kind) => !applied.has(kind))).toEqual([]);
  });
});
