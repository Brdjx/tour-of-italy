import {
  addDays,
  anchorOfPlace,
  openStatusOn,
  PACES,
  type Place,
  planDeterministic,
  type ReasonDay,
  ruleReason,
  type StopRole,
  type TripRequest,
} from "@italy/planner";
import { describe, expect, it } from "vitest";
import { shippedData } from "../../src/data";
import { checkAiReason } from "../../src/plan/reasons";

// A rule reason is what the traveler sees when an AI reason is dropped (failure vector F3).
// Nothing runs checkAiReason on it at run time, so its text is held here to the same bar as the
// AI's. The planner's rule reasons say what the stop's date means for it; this runs the real
// sanitizer over every place, role and date of a week, and over whole rules-only trips.

const { ctx } = shippedData();
const ROLES: StopRole[] = ["visit", "lunch", "dinner"];
const FRIDAY = "2026-10-09";

/**
 * The place on each day of one week, as the middle day of a three-day trip at its base, as the
 * first of two days and as the first of four (for "on Saturday or Sunday of this trip"), timed at
 * each opening that date and a little after.
 */
function daysOfAWeek(place: Place): ReasonDay[] {
  const anchorId = anchorOfPlace(ctx, place.id)?.id ?? "rome";
  const days: ReasonDay[] = [];
  for (let offset = 0; offset < 7; offset++) {
    const date = addDays(FRIDAY, offset);
    const trips = [
      { dates: [addDays(date, -1), date, addDays(date, 1)], index: 1 },
      { dates: [date, addDays(date, 1)], index: 0 },
      { dates: [0, 1, 2, 3].map((offset) => addDays(date, offset)), index: 0 },
    ].map(({ dates, index }) => ({ days: dates.map((d) => ({ date: d, anchorId })), index }));
    const status = openStatusOn(place, date);
    const opens = status.state === "open" ? status.ranges.map((range) => range.open) : [540];
    for (const trip of trips) {
      for (const start of opens.flatMap((open) => [open, open + 30])) {
        const end = start + place.durationMin;
        days.push({ date, start, end, trip, seated: [], highestRated: true });
      }
    }
  }
  return days;
}

/** One pattern per kind of sentence a rule reason can hold, each of which must be checked. */
const SENTENCE_KINDS = [
  /You asked to include this\./,
  /Matches your interest in /,
  /It cannot be visited on \w+, the trip's \w+ day\./,
  /It cannot be visited on \w+(, \w+)* or \w+ of this trip\./,
  /The only day of this trip it can be visited\./,
  /It opens later on \w+ than on other days\./,
  /Starts as it opens\./,
  /Starts as it reopens\./,
  /Starts soon after it opens\./,
  /Starts soon after it reopens\./,
  /is part of this outing\./,
  /The listing calls it a morning place\./,
  /The listing calls it an evening place\./,
  /Listed as iconic/,
  /The day's highest-rated stop\./,
  /Close to your previous stop\./,
];

// Every place, role and day of a week takes about 3 s alone and ran past Vitest's default 5 s on
// a loaded machine, so both sweeps carry their own limit.
describe("rule reasons and the AI reason sanitizer", () => {
  it("passes checkAiReason for every place, role and day of a week", () => {
    const seen = new Set<string>();
    for (const place of ctx.places) {
      const requests = [
        { interests: [], mustInclude: [] },
        { interests: place.tags, mustInclude: [place.id] },
      ];
      for (const request of requests) {
        for (const role of ROLES) {
          for (const day of daysOfAWeek(place)) {
            const text = ruleReason(place, request, role, place, day);
            expect(checkAiReason(text, place.id, ctx), text).toEqual({ ok: true, text });
            seen.add(text);
          }
        }
      }
    }
    const all = [...seen].join(" ");
    for (const kind of SENTENCE_KINDS) expect(all).toMatch(kind);
  }, 60_000);

  it("passes checkAiReason on every stop of rules-only trips from each base", () => {
    let stops = 0;
    const bases: TripRequest["anchors"][] = ["auto", ...ctx.anchors.map((anchor) => [anchor.id])];
    for (const anchors of bases) {
      for (const pace of PACES) {
        for (const startDate of [FRIDAY, "2026-12-26"]) {
          const request: TripRequest = {
            startDate,
            pace,
            interests: ["food", "art"],
            maxPriceLevel: null,
            anchors,
            mustInclude: [],
            exclude: [],
          };
          for (const day of planDeterministic(request, ctx).days) {
            for (const stop of day.stops) {
              const text = stop.reason ?? "";
              expect(checkAiReason(text, stop.placeId, ctx), text).toEqual({ ok: true, text });
              stops++;
            }
          }
        }
      }
    }
    expect(stops).toBeGreaterThan(150);
  }, 60_000);
});
