import { INTEREST_EXCLUDED_TAGS, MAX_ANCHORS_PER_TRIP } from "../src/config";
import type { PlannerContext } from "../src/context";
import { addDays, tripDates, weekdayOf } from "../src/time";
import type { Pace, PriceLevel, TripRequest } from "../src/types";

// The fixed set of trip requests the sweep plans (sweep.ts). The same seed always gives the same
// requests, so two runs, or a run against a changed copy of the planner, compare request by
// request. The mix leans toward the hard cases: trips over public holidays, low budgets, bases
// the traveler chose, must-includes, and exclusions.

/** Italian public holidays in 2026 and 2027 (Easter Sunday and Monday included). */
export const HOLIDAYS_2026_2027: readonly string[] = [
  "2026-01-01",
  "2026-01-06",
  "2026-04-05",
  "2026-04-06",
  "2026-04-25",
  "2026-05-01",
  "2026-06-02",
  "2026-08-15",
  "2026-11-01",
  "2026-12-08",
  "2026-12-25",
  "2026-12-26",
  "2027-01-01",
  "2027-01-06",
  "2027-03-28",
  "2027-03-29",
  "2027-04-25",
  "2027-05-01",
  "2027-06-02",
  "2027-08-15",
  "2027-11-01",
  "2027-12-08",
  "2027-12-25",
  "2027-12-26",
];

const FIRST_DAY = "2026-01-01";
const SPAN_DAYS = 729; // 2026-01-01 to 2027-12-30 as a start date, so every trip day is in range
/** One request in this many starts so that a public holiday falls on day 1, 2, or 3. */
const HOLIDAY_EVERY = 5;
const PACES: readonly Pace[] = ["relaxed", "balanced", "packed"];
const BUDGETS: readonly (PriceLevel | null)[] = [null, null, 1, 2, 3, 4];

/** mulberry32: a small, fast, seeded generator of floats in [0, 1). */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Pick {
  float: () => number;
  int: (below: number) => number;
  one: <T>(items: readonly T[]) => T;
  some: <T>(items: readonly T[], count: number) => T[];
}

function picker(seed: number): Pick {
  const float = seededRandom(seed);
  const int = (below: number) => Math.floor(float() * below);
  const one = <T>(items: readonly T[]): T => items[int(items.length)] as T;
  const some = <T>(items: readonly T[], count: number): T[] => {
    const left = [...items];
    const chosen: T[] = [];
    while (chosen.length < count && left.length > 0)
      chosen.push(...left.splice(int(left.length), 1));
    return chosen;
  };
  return { float, int, one, some };
}

/** The mixes of requests: "mixed" for the headline numbers, the others for targeted rules. */
export const PROFILES = ["mixed", "thin", "must", "holiday"] as const;
export type Profile = (typeof PROFILES)[number];

/** The dates most museums close (planPolicy.ts, HOLIDAY_CLOSURES) in the years the sweep covers. */
const CLOSURE_DATES = ["2026-01-01", "2026-12-25", "2027-01-01", "2027-12-25"];

/**
 * `count` requests from `seed`. One in HOLIDAY_EVERY starts 0 to 2 days before a public holiday;
 * the rest start on any day of 2026 and 2027. Paces are even. "mixed" varies interests, budgets,
 * bases, must-includes, and exclusions as travelers would. "thin" starves one chosen base (the
 * lowest budgets and 5 to 10 of its places excluded), for the rules that rescue an empty day.
 * "must" asks for 4 to 10 places in up to 3 bases, for the rules that place must-includes.
 * "holiday" is "mixed" with every trip over 25 December or 1 January.
 */
export function sweepRequests(
  ctx: PlannerContext,
  count: number,
  seed: number,
  profile: Profile = "mixed",
): TripRequest[] {
  const pick = picker(seed);
  const placeIds = ctx.places.map((place) => place.id);
  const anchorIds = ctx.anchors.map((anchor) => anchor.id);
  const placesOf = (anchorId: string) => ctx.anchorById.get(anchorId)?.placeIds ?? [];
  const interests = [...new Set(ctx.places.flatMap((place) => place.tags))]
    .filter((tag) => !INTEREST_EXCLUDED_TAGS.includes(tag))
    .sort();
  const requests: TripRequest[] = [];
  for (let n = 0; n < count; n++) {
    const holiday = pick.one(profile === "holiday" ? CLOSURE_DATES : HOLIDAYS_2026_2027);
    const before = addDays(holiday, -pick.int(3));
    const startDate =
      n % HOLIDAY_EVERY === 0 || profile === "holiday"
        ? before < FIRST_DAY
          ? holiday
          : before
        : addDays(FIRST_DAY, pick.int(SPAN_DAYS));
    const common = {
      startDate,
      pace: PACES[n % PACES.length] as Pace,
      interests: pick.float() < 0.3 ? [] : pick.some(interests, 1 + pick.int(4)),
    };
    if (profile === "thin") {
      const home = pick.one(anchorIds);
      const exclude = pick.some(placesOf(home), 5 + pick.int(6));
      const maxPriceLevel: PriceLevel = pick.float() < 0.5 ? 1 : 2;
      requests.push({ ...common, maxPriceLevel, anchors: [home], mustInclude: [], exclude });
      continue;
    }
    if (profile === "must") {
      const bases = pick.some(anchorIds, 1 + pick.int(3));
      const pool = bases.flatMap(placesOf);
      const mustInclude = pick.some(pool, 4 + pick.int(7));
      const anchors = pick.float() < 0.5 ? "auto" : bases.slice(0, MAX_ANCHORS_PER_TRIP);
      const free = placeIds.filter((id) => !mustInclude.includes(id));
      const exclude = pick.float() < 0.7 ? [] : pick.some(free, 1 + pick.int(3));
      requests.push({ ...common, maxPriceLevel: pick.one(BUDGETS), anchors, mustInclude, exclude });
      continue;
    }
    const anchorRoll = pick.float();
    const anchors: TripRequest["anchors"] =
      anchorRoll < 0.55
        ? "auto"
        : pick.some(anchorIds, anchorRoll < 0.85 ? 1 : MAX_ANCHORS_PER_TRIP);
    const mustRoll = pick.float();
    const home = anchors === "auto" ? pick.one(anchorIds) : anchors[0];
    const mustInclude =
      mustRoll < 0.5
        ? []
        : mustRoll < 0.8
          ? pick.some(placesOf(home ?? ""), 1 + pick.int(3))
          : pick.some(placeIds, 1 + pick.int(4));
    const free = placeIds.filter((id) => !mustInclude.includes(id));
    const exclude = pick.float() < 0.65 ? [] : pick.some(free, 1 + pick.int(6));
    requests.push({ ...common, maxPriceLevel: pick.one(BUDGETS), anchors, mustInclude, exclude });
  }
  return requests;
}

/** How many requests fall in each calendar case the sweep must cover. */
export function coverage(requests: readonly TripRequest[]): Record<string, number> {
  const touches = (test: (date: string) => boolean) =>
    requests.filter((request) => tripDates(request.startDate).some(test)).length;
  return {
    requests: requests.length,
    withMonday: touches((date) => weekdayOf(date) === 1),
    withSunday: touches((date) => weekdayOf(date) === 0),
    inJanuary: touches((date) => date.slice(5, 7) === "01"),
    inAugust: touches((date) => date.slice(5, 7) === "08"),
    withPublicHoliday: touches((date) => HOLIDAYS_2026_2027.includes(date)),
    withChristmasOrNewYear: touches((date) => /-(12-25|01-01)$/.test(date)),
    in2027: touches((date) => date.startsWith("2027")),
  };
}
