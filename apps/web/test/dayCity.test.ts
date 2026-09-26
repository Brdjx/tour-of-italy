import { type Itinerary, withReplannedDay } from "@italy/planner";
import { describe, expect, it, vi } from "vitest";
import type { PlanCallOptions, PlanDayBody } from "../lib/api";
import { ApiError } from "../lib/apiError";
import {
  type DayMade,
  dayClaim,
  noDaysMade,
  replannedAiDays,
  requestDay,
  shownWarnings,
  tripKey,
  tripSelection,
} from "../lib/dayCity";
import { ideasRun, jobBody } from "../lib/dayRoute";
import { AI_DAY_REASON, ctx, dayAnswer, fixturePlan, must } from "./fixtures";

// A day planned again, the parts every run shares (F13): the trip as ids, the call to POST
// /api/plan/day and the reason the page plans a day itself when it fails, and what the page says
// about a day planned again. What would break the product: a failure that surfaces as an error
// instead of a day, a fallback that claims the AI planned it, or a saved trip that claims AI why
// lines it does not have.

/** Three days in Rome (fixturePlan). */
const plan = fixturePlan();
const ROME = "rome";
const FLORENCE = "florence";

function ids(itinerary: Itinerary, day: number): string[] {
  return itinerary.days[day]?.stops.map((stop) => stop.placeId) ?? [];
}

describe("the trip as ids", () => {
  it("names the trip by its bases and places, so a changed trip has another key", () => {
    expect(tripKey(plan)).toBe(tripKey(fixturePlan()));
    const moved = {
      ...plan,
      days: [plan.days[1], plan.days[0], plan.days[2]] as Itinerary["days"],
    };
    expect(tripKey(moved)).not.toBe(tripKey(plan));
    expect(tripSelection(plan)[0]?.placeIds).toEqual(ids(plan, 0));
  });
});

describe("asking the API", () => {
  const run = ideasRun(plan, 2, ctx);
  const body = jobBody(plan.request, run.start, must(run.jobs[0]), run.route);

  it("resolves to the API's answer", async () => {
    const response = dayAnswer(plan, 2, ROME);
    const post = vi.fn(async (_body: PlanDayBody, _options: PlanCallOptions) => response);
    await expect(requestDay(body, { post }, { deterministic: true })).resolves.toEqual({
      kind: "answer",
      response,
    });
    expect(post).toHaveBeenCalledWith(body, { deterministic: true });
  });

  it("turns every failure but a cancellation into the reason the page plans the day itself", async () => {
    const cases: [unknown, string][] = [
      [new ApiError({ kind: "network", message: "down" }), "offline"],
      [new ApiError({ kind: "timeout", message: "slow" }), "timeout"],
      [new ApiError({ kind: "http", status: 429, message: "busy" }), "busy"],
      [new ApiError({ kind: "http", status: 503, message: "no" }), "server"],
      // A refused body or city can only be a version mismatch; the page's planner answers.
      [
        new ApiError({ kind: "http", status: 422, code: "day_not_allowed", message: "no" }),
        "server",
      ],
      [new ApiError({ kind: "schema", message: "shape" }), "unreadable"],
      [new TypeError("boom"), "server"],
    ];
    for (const [error, cause] of cases) {
      const post = async () => {
        throw error;
      };
      await expect(requestDay(body, { post })).resolves.toEqual({ kind: "failed", cause });
    }
    const aborted = new ApiError({ kind: "aborted", message: "cancelled" });
    await expect(
      requestDay(body, {
        post: async () => {
          throw aborted;
        },
      }),
    ).rejects.toBe(aborted);
  });

  it("uses the API client by default", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchImpl);
    try {
      // The empty object is not a day, so the client reports an unreadable reply.
      await expect(requestDay(body)).resolves.toEqual({ kind: "failed", cause: "unreadable" });
      expect(fetchImpl).toHaveBeenCalledWith(
        expect.stringMatching(/\/api\/plan\/day$/),
        expect.objectContaining({ method: "POST" }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("what the page says about a day planned again", () => {
  it("uses the source line's words with 'again'", () => {
    const cases: [DayMade, string, boolean][] = [
      [{ kind: "api", source: "ai" }, "Planned again with AI", true],
      [{ kind: "api", source: "ai_repaired" }, "Planned again with AI, fixed after a check", true],
      [{ kind: "api", source: "deterministic" }, "Planned again without AI", false],
      [
        { kind: "api", source: "deterministic", fallbackReason: "timeout" },
        "Planned again without AI: the AI planner timed out",
        false,
      ],
      [{ kind: "device", cause: "offline" }, "Planned again on this device, offline", false],
      [
        { kind: "device", cause: "invalid" },
        "Planned again on this device: the server's day broke a rule",
        false,
      ],
      [{ kind: "device", cause: null }, "Planned again on this device", false],
      // A stop changed on the day since, as the trip's source line says it.
      [{ kind: "api", source: "ai", edited: true }, "Planned again with AI, edited", true],
      [
        { kind: "device", cause: "offline", edited: true },
        "Planned again on this device, offline, edited",
        false,
      ],
    ];
    for (const [made, claim, ai] of cases) expect(dayClaim(made)).toEqual({ claim, ai });
  });

  it("names the days a saved trip gives the rules' why lines: planned again by AI, with AI words on screen", () => {
    const response = dayAnswer(plan, 2, FLORENCE);
    const trip = {
      ...plan,
      days: [plan.days[0], plan.days[1], response.dayPlan] as Itinerary["days"],
    };
    const made = noDaysMade();
    expect(replannedAiDays(trip, made)).toEqual([]);
    made[2] = { kind: "api", source: "ai" };
    expect(replannedAiDays(trip, made)).toEqual([3]);
    made[2] = { kind: "device", cause: "offline" };
    expect(replannedAiDays(trip, made)).toEqual([]);
    // Every AI line there replaced by the rules' (a claim that no longer held): nothing to say.
    made[2] = { kind: "api", source: "ai" };
    expect(replannedAiDays(plan, made)).toEqual([]);
    expect(response.dayPlan.stops.every((stop) => stop.reason === AI_DAY_REASON)).toBe(true);
  });
});

describe("the notes the page shows for a day planned again", () => {
  it("drops 'not one of your bases' on a day the traveler moved, and only there", () => {
    // Rome chosen in the form, day 3 moved to Florence from Change city.
    const rome = fixturePlan({ anchors: [ROME] });
    const moved = withReplannedDay(rome, 2, dayAnswer(rome, 2, FLORENCE).dayPlan, ctx);
    const noted = moved.warnings.filter((warning) => warning.code === "ANCHOR_NOT_CHOSEN");
    expect(noted.map((warning) => warning.day)).toEqual([2]);

    const made = noDaysMade();
    // Not planned again from the sheet (the planner's own choice): the note stays.
    expect(shownWarnings(moved.warnings, made)).toEqual(moved.warnings);
    made[2] = { kind: "api", source: "ai" };
    const shown = shownWarnings(moved.warnings, made);
    expect(shown.some((warning) => warning.code === "ANCHOR_NOT_CHOSEN")).toBe(false);
    expect(shown).toEqual(moved.warnings.filter((warning) => warning.code !== "ANCHOR_NOT_CHOSEN"));
    // A note on another day, or on none, is kept.
    const other = { ...must(noted[0]), day: 1 };
    const trip = { ...must(noted[0]), day: undefined };
    expect(shownWarnings([other, trip], made)).toEqual([other, trip]);
  });
});
