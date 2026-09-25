import type { ClaimDay, Place, Stop, StopRole } from "@italy/planner";
import { describe, expect, it } from "vitest";
import { shippedData } from "../../src/data";
import type { LlmSelection } from "../../src/llm/client";
import { applyAiReasons } from "../../src/plan/reasons";

// The API drops an AI reason whose meal, time of day, or place in the day the timed stop does
// not bear out (the planner's contradictedClaim, tested claim by claim in
// packages/planner/test/reasonClaims.test.ts), keeps the stop's rule reason, and logs why. The
// live examples come from a production plan (Florence, 2026-10-09, balanced, art and food,
// ai_repaired).

const { ctx } = shippedData();

function byName(name: string): Place {
  const place = ctx.places.find((p) => p.name === name);
  if (!place) throw new Error(`No place named ${name}`);
  return place;
}

const clock = (text: string): number => {
  const [hours = 0, minutes = 0] = text.split(":").map(Number);
  return hours * 60 + minutes;
};

/** A stop at a place from `from` to `to` ("HH:MM"), a visit unless a meal role is given. */
function stop(name: string, from: string, to: string, role: StopRole = "visit"): Stop {
  return {
    placeId: byName(name).id,
    start: clock(from),
    end: clock(to),
    travelFromPrevMin: 10,
    role,
    reason: "Rule reason.",
    reasonSource: "rule",
  };
}

// A day shaped like the live one: its lunch at 13:10, its visit at 17:55 and its dinner at 19:00
// are the production times; the other stops and the restaurants stand in.
const LIVE_DAY = [
  stop("Uffizi Gallery", "09:35", "12:35"),
  stop("Buca Mario", "13:10", "14:40", "lunch"),
  stop("Palazzo Vecchio", "15:00", "16:30"),
  stop("San Miniato al Monte", "17:55", "18:55"),
  stop("Buca dell'Orafo", "19:00", "20:30", "dinner"),
];

describe("the live examples", () => {
  it("keeps the rule reason on all three and logs why, through applyAiReasons", () => {
    const reasons = [
      "World-class gallery for art lovers.",
      "Splurge-worthy iconic restaurant for a memorable dinner.",
      "Historic palace full of Renaissance art.",
      "Historic hilltop church with scenic morning views.",
      "Local-favorite restaurant for an authentic Florentine lunch.",
    ];
    const selection: LlmSelection = {
      days: [
        {
          anchorId: "florence",
          placeIds: LIVE_DAY.map((s) => s.placeId),
          reasons: LIVE_DAY.map((s, i) => ({ placeId: s.placeId, reason: reasons[i] ?? "" })),
        },
      ],
      summary: "",
    };
    const days: ClaimDay[] = [{ date: "2026-10-09", anchorId: "florence", stops: LIVE_DAY }];

    const result = applyAiReasons(days, selection, ctx);

    expect(result.days[0]?.map((s) => s.reasonSource)).toEqual([
      "ai",
      "rule",
      "ai",
      "rule",
      "rule",
    ]);
    expect(result.days[0]?.[1]?.reason).toBe("Rule reason.");
    expect(result.stats).toEqual({
      kept: 2,
      replaced: 3,
      rejections: ["wrong_meal", "wrong_time_of_day", "wrong_meal"],
    });
  });
});

describe("the log's names for a contradicted claim", () => {
  it("logs wrong_position for a reason about the stop's place in the day", () => {
    const selection: LlmSelection = {
      days: [
        {
          anchorId: "florence",
          placeIds: LIVE_DAY.map((s) => s.placeId),
          reasons: [
            { placeId: LIVE_DAY[2]?.placeId ?? "", reason: "A grand palace to start the day." },
          ],
        },
      ],
      summary: "",
    };
    const days: ClaimDay[] = [{ date: "2026-10-09", anchorId: "florence", stops: LIVE_DAY }];

    const { stats } = applyAiReasons(days, selection, ctx);

    expect(stats.rejections).toEqual(["empty", "empty", "wrong_position", "empty", "empty"]);
  });
});
