import {
  alternativesFor,
  type Itinerary,
  placesOfAnchor,
  validateItinerary,
  validationErrors,
} from "@italy/planner";
import { describe, expect, it } from "vitest";
import {
  HISTORY_LIMIT,
  type ItineraryState,
  initialItineraryState,
  itineraryReducer,
  undoLabel,
} from "../lib/itineraryReducer";
import { ctx, fixturePlan } from "./fixtures";

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
