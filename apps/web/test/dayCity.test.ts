import { type Itinerary, MAX_ANCHORS_PER_TRIP, validationErrors } from "@italy/planner";
import { describe, expect, it, vi } from "vitest";
import type { PlanCallOptions, PlanDayBody } from "../lib/api";
import { ApiError } from "../lib/apiError";
import type { PlanDayResponse } from "../lib/apiSchemas";
import {
  cityChoices,
  type DayMade,
  dayAsk,
  dayClaim,
  dayMessage,
  dayRequestBody,
  noDaysMade,
  replannedAiDays,
  requestDay,
  resolveDay,
  SHORT_REASONS,
  tripKey,
  tripSelection,
} from "../lib/dayCity";
import { AI_DAY_REASON, ctx, dayAnswer, fixturePlan, must } from "./fixtures";

// Changing a day's city, the page's side (F13): the sheet shows the planner's own verdict for
// every city, the request carries the trip as ids, and the page takes the API's day only when it
// still fits the trip on screen; everything else is planned here by the rules and labelled so.
// What would break the product: a place on two days, a day the validator rejects shown as
// checked, a city offered that the API then refuses, or a fallback that claims the AI planned it.

/** Three days in Rome (fixturePlan): only day 3 can move to another city at once. */
const plan = fixturePlan();
const ROME = "rome";
const FLORENCE = "florence";

function ids(itinerary: Itinerary, day: number): string[] {
  return itinerary.days[day]?.stops.map((stop) => stop.placeId) ?? [];
}

describe("the Change city sheet's choices", () => {
  it("lists every base with the day's own first, and says why a city cannot be chosen", () => {
    const choices = cityChoices(plan, 1, ctx);
    expect(choices.map((choice) => choice.anchorId)).toEqual([
      ROME,
      FLORENCE,
      "milan",
      "venice",
      "bologna",
    ]);
    expect(choices[0]).toMatchObject({ current: true, allowed: true, reason: null });
    const florence = must(choices[1]);
    expect(florence.allowed).toBe(false);
    // Rome, Florence, Rome would go back and forth, so the reason says what to change first.
    expect(florence.reason).toBe(
      "A trip changes city once at most, so it cannot go from Rome to Florence and back. Move day 3 to Florence first.",
    );
  });

  it("gives each city one factual line: how the day meets the days either side, and its places", () => {
    const [rome, florence, milan] = cityChoices(plan, 2, ctx);
    expect(rome?.line).toBe("Same city as day\u00a02, 30 places");
    expect(florence).toMatchObject({ allowed: true, reason: null });
    expect(florence?.line).toBe("2 h 10 min by high-speed train from Rome, 22 places");
    expect(milan?.line).toMatch(/^3 h 35 min by .* from Rome, 18 places$/);
    expect(cityChoices(plan, 1, ctx)[0]?.line).toBe(
      "Same city as days\u00a01 and\u00a03, 30 places",
    );
    // With day 3 in Florence, day 2's lines say both sides: Florence saves the move to day 3.
    const moved = must(dayAnswer(plan, 2, FLORENCE).dayPlan);
    const trip = { ...plan, days: plan.days.map((day, i) => (i === 2 ? moved : day)) };
    const [second, secondFlorence] = cityChoices(trip, 1, ctx);
    expect(second?.line).toBe(
      "Same city as day\u00a01, 2 h 10 min on to Florence for day\u00a03, 30 places",
    );
    expect(secondFlorence).toMatchObject({ anchorId: FLORENCE, allowed: true });
    expect(secondFlorence?.line).toBe(
      "2 h 10 min by high-speed train from Rome, same city as day\u00a03, 22 places",
    );
    // The first day has no day before it: only the day after.
    expect(cityChoices(trip, 0, ctx)[0]?.line).toBe("Same city as day\u00a02, 30 places");
  });

  it("gives a reason that is the same for every city in full once, then short", () => {
    const moved = must(dayAnswer(plan, 2, FLORENCE).dayPlan);
    const trip = { ...plan, days: plan.days.map((day, i) => (i === 2 ? moved : day)) };
    const reasons = cityChoices(trip, 0, ctx).map((choice) => [choice.anchorId, choice.reason]);
    expect(reasons).toEqual([
      [ROME, null],
      [
        FLORENCE,
        "A trip changes city once at most, so it cannot go from Florence to Rome and back. Move day 2 to Florence first.",
      ],
      ["milan", "A trip can use at most 2 cities, and the other days use Rome and Florence."],
      ["venice", "Would be a third city."],
      ["bologna", "Would be a third city."],
    ]);
    // "A third city" is right only while a trip can have two.
    expect(MAX_ANCHORS_PER_TRIP).toBe(2);

    // A day holding a must-include keeps its city: named once, then short on the rows after it.
    const pinned = fixturePlan({ mustInclude: [must(ids(plan, 1)[0])] });
    const holder = pinned.days.findIndex((day) =>
      day.stops.some((stop) => pinned.request.mustInclude.includes(stop.placeId)),
    );
    const held = cityChoices(pinned, holder, ctx).filter((choice) => !choice.current);
    expect(held.map((choice) => choice.reason)).toEqual([
      expect.stringMatching(/^Day \d has .+, which you asked for\.$/),
      SHORT_REASONS.holds_must_include,
      SHORT_REASONS.holds_must_include,
      SHORT_REASONS.holds_must_include,
    ]);
  });

  it("checks the day's own city for new ideas, with its current places left out", () => {
    expect(cityChoices(plan, 0, ctx)[0]).toMatchObject({ current: true, allowed: true });
    // Every other place in Rome skipped: the day has nothing new, and the sheet says so.
    const used = new Set(plan.days.flatMap((day) => day.stops.map((stop) => stop.placeId)));
    const rest = (ctx.anchorById.get(ROME)?.placeIds ?? []).filter((id) => !used.has(id));
    const tight = { ...plan, request: { ...plan.request, exclude: rest } };
    expect(cityChoices(tight, 0, ctx)[0]).toEqual({
      anchorId: ROME,
      name: "Rome",
      current: true,
      allowed: false,
      reason: "Nothing in Rome fits day 1 with your settings.",
      line: "Same city as day\u00a02, 30 places",
    });
  });
});

describe("the request", () => {
  it("sends the trip as ids, the day and its new city, and no avoid list for another city", () => {
    const ask = dayAsk(plan, 2, FLORENCE);
    expect(ask).toEqual({ day: 2, anchorId: FLORENCE, avoid: [] });
    const body = dayRequestBody(plan, ask);
    expect(body).toEqual({
      request: plan.request,
      days: plan.days.map((day) => ({
        anchorId: day.anchorId,
        ids: ids(plan, plan.days.indexOf(day)),
      })),
      day: 2,
      anchorId: FLORENCE,
    });
    expect(body).not.toHaveProperty("avoid");
  });

  it("leaves out the day's own places for new ideas at the same city", () => {
    const ask = dayAsk(plan, 1, ROME);
    expect(ask.avoid).toEqual(ids(plan, 1));
    expect(dayRequestBody(plan, ask).avoid).toEqual(ids(plan, 1));
  });

  it("keeps the traveler's notes in the request, as POST /api/plan takes them", () => {
    const noted = fixturePlan({ notes: "Slow mornings please" });
    expect(dayRequestBody(noted, dayAsk(noted, 2, FLORENCE)).request.notes).toBe(
      "Slow mornings please",
    );
  });

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
  const body = dayRequestBody(plan, dayAsk(plan, 2, FLORENCE));

  it("resolves to the API's answer", async () => {
    const response = dayAnswer(plan, 2, FLORENCE);
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

describe("taking the API's day, or planning it here", () => {
  const ask = dayAsk(plan, 2, FLORENCE);
  const basis = tripKey(plan);

  it("takes an answer that fits the trip, with who planned it", () => {
    const response = dayAnswer(plan, 2, FLORENCE);
    const resolved = resolveDay(plan, ask, { kind: "answer", response }, basis, ctx);
    expect(resolved).toEqual({
      kind: "day",
      dayPlan: response.dayPlan,
      made: { kind: "api", source: "ai" },
    });
  });

  it("keeps why the server planned the day by rules", () => {
    const response = dayAnswer(plan, 2, FLORENCE, "deterministic");
    const resolved = resolveDay(plan, ask, { kind: "answer", response }, basis, ctx);
    expect(resolved.kind === "day" && resolved.made).toEqual({
      kind: "api",
      source: "deterministic",
      fallbackReason: "timeout",
    });
  });

  it("plans the day here, blaming the server, when its answer breaks the trip it was sent", () => {
    const good = dayAnswer(plan, 2, FLORENCE);
    const repeat = must(plan.days[0]?.stops[0]);
    const broken: PlanDayResponse[] = [
      // A place already on day 1.
      { ...good, dayPlan: { ...good.dayPlan, stops: [repeat, ...good.dayPlan.stops.slice(1)] } },
      // Another day, another city, another date, no stops, an unknown place, a twice-listed one.
      { ...good, day: 1 },
      { ...good, dayPlan: { ...good.dayPlan, anchorId: "venice" } },
      { ...good, dayPlan: { ...good.dayPlan, date: "2026-10-09" } },
      { ...good, dayPlan: { ...good.dayPlan, stops: [] } },
      {
        ...good,
        dayPlan: {
          ...good.dayPlan,
          stops: [{ ...must(good.dayPlan.stops[0]), placeId: "place_999" }],
        },
      },
      {
        ...good,
        dayPlan: {
          ...good.dayPlan,
          stops: [must(good.dayPlan.stops[0]), must(good.dayPlan.stops[0])],
        },
      },
      // A place the validator rejects: one from another city than the day's.
      {
        ...good,
        dayPlan: {
          ...good.dayPlan,
          stops: [
            {
              ...must(good.dayPlan.stops[0]),
              placeId: must(ctx.anchorById.get("venice")?.placeIds[0]),
            },
          ],
        },
      },
    ];
    for (const response of broken) {
      const resolved = resolveDay(plan, ask, { kind: "answer", response }, basis, ctx);
      expect(resolved.kind).toBe("day");
      if (resolved.kind !== "day") continue;
      expect(resolved.made).toEqual({ kind: "device", cause: "invalid" });
      expect(resolved.dayPlan.anchorId).toBe(FLORENCE);
    }
  });

  it("blames nobody when the trip changed while the day planned and the answer no longer fits", () => {
    const response = dayAnswer(plan, 2, FLORENCE);
    // Day 1 took a place the answer also has (a swap made while the day planned).
    const taken = must(response.dayPlan.stops[0]);
    const day1 = must(plan.days[0]);
    const changed: Itinerary = {
      ...plan,
      days: [
        { ...day1, stops: [...day1.stops, taken] },
        plan.days[1],
        plan.days[2],
      ] as Itinerary["days"],
    };
    const resolved = resolveDay(changed, ask, { kind: "answer", response }, basis, ctx);
    expect(resolved.kind === "day" && resolved.made).toEqual({ kind: "device", cause: null });
    if (resolved.kind === "day") {
      expect(resolved.dayPlan.stops.map((stop) => stop.placeId)).not.toContain(taken.placeId);
    }
  });

  it("plans the day here with the failure's cause when the call failed", () => {
    const resolved = resolveDay(plan, ask, { kind: "failed", cause: "offline" }, basis, ctx);
    expect(resolved.kind).toBe("day");
    if (resolved.kind !== "day") return;
    expect(resolved.made).toEqual({ kind: "device", cause: "offline" });
    const day = resolved.dayPlan;
    expect(day.anchorId).toBe(FLORENCE);
    expect(day.date).toBe(plan.days[2]?.date);
    // The rules' day: rule reasons, no place from another day, and the trip passes the check.
    expect(day.stops.every((stop) => stop.reasonSource === "rule")).toBe(true);
    const others = new Set([...ids(plan, 0), ...ids(plan, 1)]);
    expect(day.stops.some((stop) => others.has(stop.placeId))).toBe(false);
    const trip = { ...plan, days: [plan.days[0], plan.days[1], day] as Itinerary["days"] };
    expect(validationErrors(trip, ctx)).toEqual([]);
  });

  it("refuses with the planner's reason when the rules cannot plan the day either", () => {
    const refused = resolveDay(
      plan,
      dayAsk(plan, 1, FLORENCE),
      { kind: "failed", cause: "server" },
      basis,
      ctx,
    );
    expect(refused).toEqual({
      kind: "refused",
      reason: expect.stringContaining("Move day 3 to Florence first."),
    });
    const gone = resolveDay(
      plan,
      { day: 5, anchorId: FLORENCE, avoid: [] },
      { kind: "failed", cause: "server" },
      basis,
      ctx,
    );
    expect(gone).toEqual({ kind: "refused", reason: "That day or city is no longer in the plan." });
    const nowhere = resolveDay(
      plan,
      { day: 0, anchorId: "naples", avoid: [] },
      { kind: "failed", cause: "server" },
      basis,
      ctx,
    );
    expect(nowhere.kind).toBe("refused");
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
    ];
    for (const [made, claim, ai] of cases) expect(dayClaim(made)).toEqual({ claim, ai });
  });

  it("announces the change in a few words, and how when the AI did not plan it", () => {
    expect(dayMessage(1, "Florence", true, { kind: "api", source: "ai" })).toBe(
      "Day 2 now in Florence.",
    );
    expect(dayMessage(1, "Rome", false, { kind: "api", source: "ai_repaired" })).toBe(
      "New ideas for day 2.",
    );
    expect(dayMessage(2, "Venice", true, { kind: "api", source: "deterministic" })).toBe(
      "Day 3 now in Venice. Planned without AI.",
    );
    expect(dayMessage(0, "Rome", false, { kind: "device", cause: "offline" })).toBe(
      "New ideas for day 1. Planned without AI on this device.",
    );
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
