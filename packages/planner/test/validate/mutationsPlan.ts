import { dayOf, stopOf } from "./fixtures";
import type { Mutation } from "./mutationRunner";
import { tripMilan, tripNewYear, tripRome, tripTuscany } from "./trips";

// Mutations that break the plan's shape or its claims: ids, exclusions, bases, day count, dates,
// must-includes, the visit cap, meal labels, and travel claims.

export const PLAN_MUTATIONS: Mutation[] = [
  {
    name: "duplicate a stop from day 1 onto day 3",
    build: tripRome,
    corrupt: (p) => {
      stopOf(p, 2, 1).placeId = "place_077";
    },
    code: "DUPLICATE_PLACE",
    placeId: "place_077",
  },
  {
    name: "move a Rome stop to a Florence place",
    build: tripRome,
    corrupt: (p) => {
      stopOf(p, 1, 3).placeId = "place_103";
    },
    code: "OUTSIDE_ANCHOR",
    placeId: "place_103",
  },
  {
    name: "replace a stop with an invented id",
    build: tripNewYear,
    corrupt: (p) => {
      stopOf(p, 2, 1).placeId = "place_000";
    },
    code: "UNKNOWN_PLACE",
    placeId: "place_000",
  },
  {
    name: "exclude a place the plan uses",
    build: tripMilan,
    corrupt: (p) => {
      p.request.exclude.push("place_055");
    },
    code: "EXCLUDED_PLACE",
    placeId: "place_055",
  },
  {
    name: "drop the Vatican Museums, a placeable must-include",
    build: tripRome,
    corrupt: (p) => {
      dayOf(p, 1).stops.splice(0, 1);
    },
    code: "MUST_INCLUDE_MISSING",
    placeId: "place_010",
  },
  {
    name: "drop Villa del Balbianello, a placeable must-include on a day trip",
    build: tripMilan,
    corrupt: (p) => {
      dayOf(p, 1).stops.splice(0, 1);
    },
    code: "MUST_INCLUDE_MISSING",
    placeId: "place_064",
  },
  {
    name: "label both meals of a full relaxed day as visits",
    build: tripTuscany,
    corrupt: (p) => {
      for (const stop of dayOf(p, 0).stops) stop.role = "visit";
    },
    code: "TOO_MANY_VISITS",
    day: 0,
  },
  {
    name: "empty a day",
    build: tripMilan,
    corrupt: (p) => {
      dayOf(p, 2).stops = [];
    },
    code: "EMPTY_DAY",
    day: 2,
  },
  {
    name: "drop the last day (2 days)",
    build: tripNewYear,
    corrupt: (p) => {
      p.days.pop();
    },
    code: "WRONG_DAY_COUNT",
  },
  {
    name: "add a fourth day",
    build: tripRome,
    corrupt: (p) => {
      p.days.push({ ...dayOf(p, 2), date: "2026-10-23", stops: [] });
    },
    code: "WRONG_DAY_COUNT",
  },
  {
    name: "send day 2 of a two-base trip to a third base",
    build: tripTuscany,
    corrupt: (p) => {
      dayOf(p, 1).anchorId = "rome";
    },
    code: "TOO_MANY_ANCHORS",
  },
  {
    name: "claim the Rome to Venice transfer takes 1 h",
    build: tripNewYear,
    corrupt: (p) => {
      dayOf(p, 1).transferMin = 60;
    },
    code: "WRONG_TRAVEL",
    day: 1,
  },
  {
    name: "claim the base to Villa del Balbianello leg takes 10 min",
    build: tripMilan,
    corrupt: (p) => {
      stopOf(p, 1, 0).travelFromPrevMin = 10;
    },
    code: "WRONG_TRAVEL",
    placeId: "place_064",
  },
  {
    name: "date a day one day late",
    build: tripNewYear,
    corrupt: (p) => {
      dayOf(p, 1).date = "2027-01-03";
    },
    code: "WRONG_DATE",
    day: 1,
  },
  {
    name: "set a day in a base that does not exist",
    build: tripRome,
    corrupt: (p) => {
      dayOf(p, 2).anchorId = "naples";
    },
    code: "UNKNOWN_ANCHOR",
    day: 2,
  },
  {
    name: "label the Galleria Vittorio Emanuele as dinner",
    build: tripMilan,
    corrupt: (p) => {
      stopOf(p, 0, 4).role = "dinner";
    },
    code: "NOT_A_MEAL_PLACE",
    placeId: "place_060",
  },
];
