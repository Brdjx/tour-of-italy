import {
  alternativesFor,
  type Itinerary,
  placesOfAnchor,
  validateItinerary,
  validationErrors,
} from "@italy/planner";
import { describe, expect, it } from "vitest";
import { dayAsk, tripKey } from "../lib/dayCity";
import {
  HISTORY_LIMIT,
  type ItineraryState,
  initialItineraryState,
  isEdited,
  itineraryReducer,
  undoLabel,
} from "../lib/itineraryReducer";
import { AI_DAY_REASON, aiPlan, ctx, dayAnswer, fixturePlan, must } from "./fixtures";

// Every edit must rebuild the day with the planner, rerun the independent validator, keep undo
// exact, and never mutate the plan it started from (undo depends on that).

function planned(itinerary: Itinerary = fixturePlan()): ItineraryState {
  return itineraryReducer(initialItineraryState(), { type: "plan", itinerary, origin: "api" }, ctx);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function ids(state: ItineraryState, day: number): string[] {
  return state.itinerary?.days[day]?.stops.map((stop) => stop.placeId) ?? [];
}

describe("plan", () => {
  it("starts a clean history and validates the new plan", () => {
    const state = planned();
    expect(state.itinerary?.days).toHaveLength(3);
    expect(state.errors).toEqual([]);
    expect(state.history).toEqual([]);
    expect(state.planId).toBe(1);
    expect(state.message).toBe("Your plan is ready.");
  });

  it("flags a plan from the API that fails the browser's own check (stale data on one side)", () => {
    const plan = fixturePlan();
    const day = plan.days[0];
    if (!day?.stops[0]) throw new Error("fixture has no stops");
    const tampered: Itinerary = {
      ...plan,
      days: [{ ...day, stops: [{ ...day.stops[0], start: 60, end: 120 }] }, ...plan.days.slice(1)],
    };
    const state = planned(tampered);
    expect(state.errors.length).toBeGreaterThan(0);
  });

  it("does not validate without places, and says nothing is broken", () => {
    const state = itineraryReducer(
      initialItineraryState(),
      { type: "plan", itinerary: fixturePlan(), origin: "shared", message: "Opened" },
      null,
    );
    expect(state.errors).toEqual([]);
    expect(state.origin).toBe("shared");
    expect(state.message).toBe("Opened");
  });
});

describe("edits", () => {
  it("swaps in a valid alternative, retimes the day, and leaves no error", () => {
    const state = planned(deepFreeze(fixturePlan()));
    const plan = state.itinerary as Itinerary;
    const [alternative] = alternativesFor(plan, 0, 1, ctx);
    if (!alternative) throw new Error("no alternative for day 1 stop 2");
    const next = itineraryReducer(
      state,
      { type: "swap", day: 0, stop: 1, placeId: alternative.place.id },
      ctx,
    );
    expect(ids(next, 0)[1]).toBe(alternative.place.id);
    expect(next.itinerary?.days[0]?.stops[1]?.start).toBe(alternative.stop.start);
    expect(next.errors).toEqual([]);
    expect(validationErrors(next.itinerary as Itinerary, ctx)).toEqual([]);
    expect(next.changed).toEqual({ day: 0, stop: 1 });
    expect(undoLabel(next)).toBe("Undo swap");
    expect(next.message).toMatch(/^Swapped .+ for .+\. Times updated\.$/);
  });

  it("keeps a swap that breaks a rule, flags it, and names the problem", () => {
    const state = planned();
    const outsider = placesOfAnchor(ctx, "milan")[0];
    if (!outsider) throw new Error("no Milan place");
    const next = itineraryReducer(
      state,
      { type: "swap", day: 0, stop: 0, placeId: outsider.id },
      ctx,
    );
    expect(ids(next, 0)[0]).toBe(outsider.id);
    expect(next.errors.some((error) => error.code === "OUTSIDE_ANCHOR" && error.day === 0)).toBe(
      true,
    );
    expect(next.message).toContain("see the flagged stops, or undo");
  });

  it("removes a stop and retimes the rest of the day from the planner", () => {
    const state = planned();
    const before = ids(state, 1);
    const next = itineraryReducer(state, { type: "remove", day: 1, stop: 0 }, ctx);
    expect(ids(next, 1)).toEqual(before.slice(1));
    const first = next.itinerary?.days[1]?.stops[0];
    const original = state.itinerary?.days[1]?.stops[1];
    expect(first?.placeId).toBe(original?.placeId);
    expect(first?.travelFromPrevMin).not.toBeUndefined();
    const rerun = validateItinerary(next.itinerary as Itinerary, ctx).filter(
      (violation) => violation.severity === "error",
    );
    expect(next.errors).toEqual(rerun);
  });

  it("refuses to empty a day, which would be an error-level plan", () => {
    let state = planned();
    while ((state.itinerary?.days[2]?.stops.length ?? 0) > 1) {
      state = itineraryReducer(state, { type: "remove", day: 2, stop: 0 }, ctx);
    }
    const refused = itineraryReducer(state, { type: "remove", day: 2, stop: 0 }, ctx);
    expect(refused.itinerary).toBe(state.itinerary);
    expect(refused.message).toBe("A day needs at least one stop. Swap this one instead.");
  });

  it("moves a stop up and down and ignores moves past either end", () => {
    const state = planned();
    const before = ids(state, 0);
    const up = itineraryReducer(state, { type: "move", day: 0, stop: 1, direction: "up" }, ctx);
    expect(ids(up, 0).slice(0, 2)).toEqual([before[1], before[0]]);
    expect(up.changed).toEqual({ day: 0, stop: 0 });
    const down = itineraryReducer(state, { type: "move", day: 0, stop: 0, direction: "down" }, ctx);
    expect(ids(down, 0).slice(0, 2)).toEqual([before[1], before[0]]);
    expect(itineraryReducer(state, { type: "move", day: 0, stop: 0, direction: "up" }, ctx)).toBe(
      state,
    );
    const last = before.length - 1;
    expect(
      itineraryReducer(state, { type: "move", day: 0, stop: last, direction: "down" }, ctx),
    ).toBe(state);
  });

  it("gives a moved stop the rules' reason when the AI's no longer holds, and keeps the rest", () => {
    // Tuesday 6 October 2026: Trastevere starts the day, the Colosseum follows lunch.
    const plan = fixturePlan();
    const reasons: Record<string, string> = {
      place_002: "A lively neighborhood to start the day.",
      place_001: "Ancient Rome's great arena.",
    };
    const fromApi: Itinerary = {
      ...plan,
      source: "ai",
      days: plan.days.map((day) => ({
        ...day,
        stops: day.stops.map((stop) => {
          const reason = reasons[stop.placeId];
          return reason === undefined ? stop : { ...stop, reason, reasonSource: "ai" as const };
        }),
      })),
    };
    const state = planned(fromApi);
    expect(ids(state, 0)[0]).toBe("place_002");
    const next = itineraryReducer(state, { type: "move", day: 0, stop: 0, direction: "down" }, ctx);
    const stops = next.itinerary?.days[0]?.stops ?? [];
    const trastevere = stops.find((stop) => stop.placeId === "place_002");
    // The row's mark follows reasonSource (StopRow): the rules' open ring, not the AI's dot.
    expect(stops.indexOf(trastevere as (typeof stops)[number])).toBe(1);
    expect(trastevere?.reasonSource).toBe("rule");
    expect(trastevere?.reason).not.toBe(reasons.place_002);
    expect(stops.find((stop) => stop.placeId === "place_001")).toMatchObject({
      reason: reasons.place_001,
      reasonSource: "ai",
    });
  });

  it("answers an edit on a stop that no longer exists instead of throwing", () => {
    const state = planned();
    for (const action of [
      { type: "remove", day: 9, stop: 0 },
      { type: "remove", day: 0, stop: 99 },
      { type: "move", day: -1, stop: 0, direction: "up" },
      { type: "swap", day: 0, stop: 42, placeId: "place_001" },
    ] as const) {
      const next = itineraryReducer(state, action, ctx);
      expect(next.itinerary).toBe(state.itinerary);
      expect(next.message).toBe("That stop is no longer here.");
    }
    const empty = itineraryReducer(
      initialItineraryState(),
      { type: "remove", day: 0, stop: 0 },
      ctx,
    );
    expect(empty.itinerary).toBeNull();
  });

  it("refuses a swap to an unknown place or to the same place", () => {
    const state = planned();
    const same = ids(state, 0)[0] as string;
    for (const placeId of ["place_999", same]) {
      const next = itineraryReducer(state, { type: "swap", day: 0, stop: 0, placeId }, ctx);
      expect(next.itinerary).toBe(state.itinerary);
      expect(next.message).toBe("That place cannot be used.");
    }
  });

  it("refuses edits while the places are not loaded", () => {
    const state = planned();
    const next = itineraryReducer(state, { type: "remove", day: 0, stop: 0 }, null);
    expect(next.itinerary).toBe(state.itinerary);
    expect(next.message).toBe("Places are still loading. Try again in a moment.");
  });
});

describe("edited", () => {
  it("is edited while an edit is in the undo history, and not once every edit is undone", () => {
    const first = planned();
    expect(isEdited(first)).toBe(false);
    const removed = itineraryReducer(first, { type: "remove", day: 1, stop: 2 }, ctx);
    expect(isEdited(removed)).toBe(true);
    expect(isEdited(itineraryReducer(removed, { type: "undo" }, ctx))).toBe(false);
  });

  it("stays edited after a reload, when the undo history is gone, until a new plan arrives", () => {
    const restored = itineraryReducer(
      initialItineraryState(),
      { type: "plan", itinerary: fixturePlan(), origin: "api", edited: true },
      ctx,
    );
    expect(restored.history).toEqual([]);
    expect(isEdited(restored)).toBe(true);
    const moved = itineraryReducer(
      restored,
      { type: "move", day: 1, stop: 1, direction: "up" },
      ctx,
    );
    expect(isEdited(itineraryReducer(moved, { type: "undo" }, ctx))).toBe(true);
    const fresh = itineraryReducer(
      restored,
      { type: "plan", itinerary: fixturePlan(), origin: "api" },
      ctx,
    );
    expect(isEdited(fresh)).toBe(false);
  });
});

describe("undo", () => {
  it("restores the exact previous plan and its flags, one step at a time", () => {
    const first = planned();
    const outsider = placesOfAnchor(ctx, "venice")[0]?.id as string;
    const broken = itineraryReducer(
      first,
      { type: "swap", day: 0, stop: 0, placeId: outsider },
      ctx,
    );
    const moved = itineraryReducer(broken, { type: "move", day: 1, stop: 1, direction: "up" }, ctx);
    expect(undoLabel(moved)).toBe("Undo move");
    const back1 = itineraryReducer(moved, { type: "undo" }, ctx);
    expect(back1.itinerary).toBe(broken.itinerary);
    expect(back1.errors).toEqual(broken.errors);
    const back2 = itineraryReducer(back1, { type: "undo" }, ctx);
    expect(back2.itinerary).toBe(first.itinerary);
    expect(back2.errors).toEqual([]);
    expect(undoLabel(back2)).toBeNull();
    expect(itineraryReducer(back2, { type: "undo" }, ctx).message).toBe("Nothing to undo.");
  });

  it("marks the row that came back, so the page can put focus on it when Undo disappears", () => {
    const first = planned();
    const removed = itineraryReducer(first, { type: "remove", day: 1, stop: 2 }, ctx);
    const back = itineraryReducer(removed, { type: "undo" }, ctx);
    expect(back.changed).toEqual({ day: 1, stop: 2 });
    const moved = itineraryReducer(
      first,
      { type: "move", day: 0, stop: 1, direction: "down" },
      ctx,
    );
    expect(itineraryReducer(moved, { type: "undo" }, ctx).changed).toEqual({ day: 0, stop: 1 });
  });

  it("keeps the fallback cause of a new plan and forgets it on the next plan", () => {
    const offline = itineraryReducer(
      initialItineraryState(),
      { type: "plan", itinerary: fixturePlan(), origin: "offline", cause: "busy" },
      ctx,
    );
    expect(offline.cause).toBe("busy");
    const edited = itineraryReducer(offline, { type: "remove", day: 0, stop: 0 }, ctx);
    expect(edited.cause).toBe("busy");
    const next = itineraryReducer(
      edited,
      { type: "plan", itinerary: fixturePlan(), origin: "api" },
      ctx,
    );
    expect(next.cause).toBeNull();
  });

  it("keeps the saved trip a plan was opened from through edits, and forgets it on the next plan", () => {
    const saved = {
      id: "a1B2c3D4e5",
      createdAt: "2026-09-20T12:00:00.000Z",
      plannedBy: "ai" as const,
      edited: false,
      retimed: false,
    };
    const opened = itineraryReducer(
      initialItineraryState(),
      { type: "plan", itinerary: fixturePlan(), origin: "saved", saved },
      ctx,
    );
    const edited = itineraryReducer(opened, { type: "remove", day: 0, stop: 0 }, ctx);
    const undone = itineraryReducer(edited, { type: "undo" }, ctx);
    expect([opened.saved, edited.saved, undone.saved]).toEqual([saved, saved, saved]);
    const next = itineraryReducer(
      undone,
      { type: "plan", itinerary: fixturePlan(), origin: "api" },
      ctx,
    );
    expect(next.saved).toBeNull();
    expect(itineraryReducer(undone, { type: "clear" }, ctx).saved).toBeNull();
  });

  it("keeps a bounded history so long sessions cannot grow memory without limit", () => {
    let state = planned();
    for (let index = 0; index < HISTORY_LIMIT + 5; index++) {
      state = itineraryReducer(state, { type: "move", day: 0, stop: 0, direction: "down" }, ctx);
    }
    expect(state.history).toHaveLength(HISTORY_LIMIT);
  });

  it("clears the plan but keeps counting plans, so the next plan still animates", () => {
    const state = planned();
    const cleared = itineraryReducer(state, { type: "clear" }, ctx);
    expect(cleared.itinerary).toBeNull();
    expect(cleared.planId).toBe(state.planId);
  });
});

describe("a day planned again", () => {
  function replanned(state: ItineraryState, day: number, anchorId: string) {
    const itinerary = must(state.itinerary);
    const response = dayAnswer(itinerary, day, anchorId);
    const ask = dayAsk(itinerary, day, anchorId);
    const action = {
      type: "day",
      ask,
      reply: { kind: "answer", response },
      basis: tripKey(itinerary),
    } as const;
    return itineraryReducer(state, action, ctx);
  }

  it("goes in as one edit: the new city, the whole trip timed again, and the validator's verdict", () => {
    const before = planned(aiPlan());
    deepFreeze(before);
    const after = replanned(before, 2, "florence");
    const day = must(after.itinerary?.days[2]);
    expect(day.anchorId).toBe("florence");
    expect(after.errors).toEqual([]);
    expect(validationErrors(must(after.itinerary), ctx)).toEqual([]);
    expect(after.history).toHaveLength(1);
    expect(after.history[0]).toMatchObject({ kind: "city", at: { day: 2, stop: 0 } });
    expect(undoLabel(after)).toBe("Undo city change");
    expect(isEdited(after)).toBe(true);
    expect(after.message).toBe("Day 3 now in Florence.");
    expect(after.dayMade).toEqual([null, null, { kind: "api", source: "ai" }]);
    // The other days keep their places, and no place is on two days.
    expect(ids(after, 0)).toEqual(ids(before, 0));
    expect(ids(after, 1)).toEqual(ids(before, 1));
    const all = [0, 1, 2].flatMap((index) => ids(after, index));
    expect(new Set(all).size).toBe(all.length);
    // The AI's words on the new day stay, with their AI marks.
    expect(
      day.stops.every((stop) => stop.reasonSource === "ai" && stop.reason === AI_DAY_REASON),
    ).toBe(true);
    // A summary about three days in Rome is not true of this trip any more.
    expect(after.itinerary?.summary).toBeUndefined();
  });

  it("gives new ideas at the same city: other places, the summary kept, its own undo label", () => {
    const before = planned(aiPlan());
    const after = replanned(before, 1, "rome");
    expect(after.itinerary?.days[1]?.anchorId).toBe("rome");
    expect(ids(after, 1).some((id) => ids(before, 1).includes(id))).toBe(false);
    expect(after.itinerary?.summary).toBe("Three days of food in Rome.");
    expect(undoLabel(after)).toBe("Undo new ideas");
    expect(after.message).toBe("New ideas for day 2.");
  });

  it("is undone whole: the day, its city, the next day's times and how it was made", () => {
    const before = planned(aiPlan());
    const moved = replanned(before, 2, "florence");
    const again = replanned(moved, 1, "florence");
    expect(again.dayMade).toEqual([
      null,
      { kind: "api", source: "ai" },
      { kind: "api", source: "ai" },
    ]);
    const once = itineraryReducer(again, { type: "undo" }, ctx);
    expect(once.itinerary).toEqual(moved.itinerary);
    expect(once.dayMade).toEqual(moved.dayMade);
    expect(once.changed).toEqual({ day: 1, stop: 0 });
    const twice = itineraryReducer(once, { type: "undo" }, ctx);
    expect(twice.itinerary).toEqual(before.itinerary);
    expect(twice.dayMade).toEqual([null, null, null]);
    expect(isEdited(twice)).toBe(false);
  });

  it("keeps the record of a day planned again through other edits, and drops it with a new plan", () => {
    const moved = replanned(planned(), 2, "florence");
    const swapped = itineraryReducer(
      moved,
      { type: "move", day: 2, stop: 0, direction: "down" },
      ctx,
    );
    // A stop changed on that day since: the day's line says so, as the trip's does.
    expect(swapped.dayMade[2]).toEqual({ kind: "api", source: "ai", edited: true });
    expect(itineraryReducer(swapped, { type: "undo" }, ctx).dayMade[2]).toEqual({
      kind: "api",
      source: "ai",
    });
    // An edit on another day leaves the record as it was.
    const elsewhere = itineraryReducer(moved, { type: "remove", day: 0, stop: 0 }, ctx);
    expect(elsewhere.dayMade).toEqual(moved.dayMade);
    const next = itineraryReducer(
      swapped,
      { type: "plan", itinerary: fixturePlan(), origin: "api" },
      ctx,
    );
    expect(next.dayMade).toEqual([null, null, null]);
    const restored = itineraryReducer(
      initialItineraryState(),
      { type: "plan", itinerary: must(swapped.itinerary), origin: "api", dayMade: swapped.dayMade },
      ctx,
    );
    expect(restored.dayMade).toEqual(swapped.dayMade);
  });

  it("plans the day here when the call failed, and says so", () => {
    const before = planned();
    const itinerary = must(before.itinerary);
    const action = {
      type: "day",
      ask: dayAsk(itinerary, 2, "venice"),
      reply: { kind: "failed", cause: "offline" },
      basis: tripKey(itinerary),
    } as const;
    const after = itineraryReducer(before, action, ctx);
    expect(after.itinerary?.days[2]?.anchorId).toBe("venice");
    expect(after.dayMade[2]).toEqual({ kind: "device", cause: "offline" });
    expect(after.message).toBe("Day 3 now in Venice. Planned without AI on this device.");
    expect(after.errors).toEqual([]);
  });

  it("refuses a city the rules cannot plan either, with the planner's reason, and changes nothing", () => {
    const before = planned();
    const itinerary = must(before.itinerary);
    const action = {
      type: "day",
      ask: dayAsk(itinerary, 1, "florence"),
      reply: { kind: "failed", cause: "server" },
      basis: tripKey(itinerary),
    } as const;
    const after = itineraryReducer(before, action, ctx);
    expect(after.itinerary).toBe(before.itinerary);
    expect(after.history).toEqual([]);
    expect(after.message).toContain("Move day 3 to Florence first.");
  });

  it("does nothing without a plan or the places", () => {
    const itinerary = fixturePlan();
    const action = {
      type: "day",
      ask: dayAsk(itinerary, 2, "florence"),
      reply: { kind: "failed", cause: "server" },
      basis: tripKey(itinerary),
    } as const;
    expect(itineraryReducer(initialItineraryState(), action, ctx).message).toBe(
      "That day is no longer here.",
    );
    const before = planned();
    expect(itineraryReducer(before, action, null).message).toBe(
      "Places are still loading. Try again in a moment.",
    );
  });
});
