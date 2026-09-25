import type { Itinerary } from "@italy/planner";
import { addDays, buildPlannerContext, TRIP_DAYS } from "@italy/planner";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { initialItineraryState, isEdited, itineraryReducer } from "../lib/itineraryReducer";
import {
  type KeyValueStore,
  LAST_PLAN_KEY,
  LAST_PLAN_MAX_CHARS,
  readLastPlan,
  restoredNote,
  saveLastPlan,
} from "../lib/lastPlan";
import { ctx, fixturePlan, must, places } from "./fixtures";

// The saved last plan (F8 and F9 for storage): whatever is in localStorage is hostile input.
// What would break the product: a crash on open from a corrupt value, an old or edited value
// shown as a real plan, a plan naming places that no longer exist, a plan for a trip that is
// over, or blocked storage (private mode, quota) throwing into the page.

vi.setConfig({ testTimeout: 20_000 }); // the fuzz test parses 300 values with the full schema

const NOW = new Date(2026, 8, 23, 12, 0); // Wednesday 23 September 2026, local time
const DAY = 24 * 60 * 60 * 1000;

class MemoryStore implements KeyValueStore {
  readonly map = new Map<string, string>();
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.map.set(key, value);
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
}

function stored(value: unknown): MemoryStore {
  const store = new MemoryStore();
  store.setItem(LAST_PLAN_KEY, typeof value === "string" ? value : JSON.stringify(value));
  return store;
}

function record(itinerary: Itinerary = fixturePlan(), overrides: Record<string, unknown> = {}) {
  return { v: 1, savedAt: NOW.toISOString(), origin: "api", itinerary, ...overrides };
}

function expectDiscarded(store: MemoryStore, reason: string) {
  expect(readLastPlan(store, ctx, NOW)).toEqual({ status: "discarded", reason });
  expect(store.map.has(LAST_PLAN_KEY)).toBe(false);
}

describe("saving and reading the last plan", () => {
  it("brings back the same plan and who planned it", () => {
    const store = new MemoryStore();
    const plan = fixturePlan({ notes: "Slow mornings please" });
    for (const origin of ["api", "offline", "shared"] as const) {
      expect(saveLastPlan(store, plan, origin, NOW)).toBe(true);
      expect(readLastPlan(store, ctx, NOW)).toEqual({
        status: "restored",
        itinerary: plan,
        origin,
        cause: null,
        saved: null,
        edited: false,
        flagged: 0,
      });
    }
  });

  it("keeps the saved trip a plan was opened from, so the source line says so after a reload", () => {
    const store = new MemoryStore();
    const plan = { ...fixturePlan(), planId: "a1B2c3D4e5" };
    const saved = {
      id: "Zz9Yy8Xx7W",
      createdAt: "2026-09-20T18:30:00.000Z",
      plannedBy: "ai_repaired" as const,
      edited: true,
      retimed: false,
    };
    saveLastPlan(store, plan, "saved", NOW, { saved });
    const read = readLastPlan(store, ctx, NOW);
    expect(read).toMatchObject({ status: "restored", origin: "saved", saved, itinerary: plan });
    // A saved-trip record whose id is not a record id is not a plan this page wrote.
    const forged = stored(record(plan, { origin: "saved", saved: { ...saved, id: "../x" } }));
    expectDiscarded(forged, "invalid");
  });

  it("keeps why a plan was built on this device, so a reopened plan is labelled the same", () => {
    const store = new MemoryStore();
    const plan = fixturePlan();
    saveLastPlan(store, plan, "offline", NOW, { cause: "busy" });
    const read = readLastPlan(store, ctx, NOW);
    expect(read.status === "restored" && read.cause).toBe("busy");
    // Records saved before the cause was kept still open, with no cause.
    const old = stored(record(plan, { origin: "offline" }));
    const legacy = readLastPlan(old, ctx, NOW);
    expect(legacy.status === "restored" && legacy.cause).toBe(null);
  });

  it("brings back a plan the traveler edited, not only fresh ones", () => {
    let state = itineraryReducer(
      initialItineraryState(),
      { type: "plan", itinerary: fixturePlan(), origin: "api" },
      ctx,
    );
    state = itineraryReducer(state, { type: "remove", day: 0, stop: 0 }, ctx);
    state = itineraryReducer(state, { type: "move", day: 1, stop: 1, direction: "up" }, ctx);
    const edited = must(state.itinerary, "edited plan");
    const store = new MemoryStore();
    saveLastPlan(store, edited, state.origin, NOW, { edited: isEdited(state) });
    const read = readLastPlan(store, ctx, NOW);
    expect(read.status).toBe("restored");
    if (read.status === "restored") expect(read.itinerary).toEqual(edited);
    // The edit is remembered, so the source line never claims the plan is as it arrived.
    expect(read.status === "restored" && read.edited).toBe(true);
    // Records saved before the flag was kept open as unedited.
    const legacy = readLastPlan(stored(record(edited, { origin: "api" })), ctx, NOW);
    expect(legacy.status === "restored" && legacy.edited).toBe(false);
  });

  it("reports nothing saved when the key is missing", () => {
    expect(readLastPlan(new MemoryStore(), ctx, NOW)).toEqual({ status: "none" });
  });

  it("never throws when the browser blocks storage", () => {
    const blocked: KeyValueStore = {
      getItem: () => {
        throw new DOMException("denied", "SecurityError");
      },
      setItem: () => {
        throw new DOMException("full", "QuotaExceededError");
      },
      removeItem: () => {
        throw new DOMException("denied", "SecurityError");
      },
    };
    expect(saveLastPlan(blocked, fixturePlan(), "api", NOW)).toBe(false);
    expect(readLastPlan(blocked, ctx, NOW)).toEqual({ status: "none" });
  });

  it("still discards a bad value when removing it throws", () => {
    const store = stored("{broken");
    store.removeItem = () => {
      throw new DOMException("denied", "SecurityError");
    };
    expect(readLastPlan(store, ctx, NOW)).toEqual({ status: "discarded", reason: "unreadable" });
  });
});

describe("corrupt and schema-invalid values are discarded", () => {
  it("discards a value that is not JSON", () => {
    expectDiscarded(stored("{not json"), "unreadable");
  });

  it("discards a value too long to be a plan without parsing it", () => {
    expectDiscarded(stored(`"${"x".repeat(LAST_PLAN_MAX_CHARS)}"`), "unreadable");
  });

  const plan = fixturePlan();
  const day0 = must(plan.days[0], "day 0");
  const stop0 = must(day0.stops[0], "stop 0");
  const withDay0 = (changes: Record<string, unknown>) => ({
    ...plan,
    days: [{ ...day0, ...changes }, ...plan.days.slice(1)],
  });
  const INVALID: Array<[string, unknown]> = [
    ["null", null],
    ["a number", 42],
    ["an array", [record()]],
    ["another storage version", record(plan, { v: 2 })],
    ["no version", { savedAt: NOW.toISOString(), origin: "api", itinerary: plan }],
    ["an unknown origin", record(plan, { origin: "hacker" })],
    ["a savedAt that is not a date", record(plan, { savedAt: "yesterday" })],
    ["an extra top-level field", record(plan, { admin: true })],
    ["no itinerary", { v: 1, savedAt: NOW.toISOString(), origin: "api" }],
    ["a day missing", record({ ...plan, days: plan.days.slice(0, -1) })],
    ["an extra day", record({ ...plan, days: [...plan.days, day0] })],
    ["an extra itinerary field", record({ ...plan, script: "x" } as unknown as Itinerary)],
    [
      "a stop that ends before it starts",
      record(withDay0({ stops: [{ ...stop0, end: stop0.start - 5 }] })),
    ],
    ["a stop at minute -30", record(withDay0({ stops: [{ ...stop0, start: -30 }] }))],
    [
      "an error stored as a warning",
      record({
        ...plan,
        warnings: [{ code: "OVERLAP", severity: "error", detail: "x" }],
      } as unknown as Itinerary),
    ],
    ["an unknown source", record({ ...plan, source: "magic" } as unknown as Itinerary)],
    [
      "a request with an unknown field",
      record({ ...plan, request: { ...plan.request, admin: true } } as unknown as Itinerary),
    ],
  ];

  it.each(INVALID)("discards a stored value with %s", (_name, value) => {
    expectDiscarded(stored(value), "invalid");
  });

  it("discards a prototype-pollution payload and leaves Object.prototype clean", () => {
    const payload = `{"__proto__":{"polluted":true},"v":1,"savedAt":"${NOW.toISOString()}","origin":"api","itinerary":${JSON.stringify(plan)}}`;
    expectDiscarded(stored(payload), "invalid");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("never throws and never restores arbitrary stored values", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string(),
          fc.jsonValue().map((value) => JSON.stringify(value)),
        ),
        (raw) => {
          const store = stored(raw);
          const read = readLastPlan(store, ctx, NOW);
          expect(read.status).toBe("discarded");
          expect(store.map.has(LAST_PLAN_KEY)).toBe(false);
        },
      ),
      { numRuns: 300, seed: 29 },
    );
  });
});

describe("stale plans are discarded", () => {
  it("discards a plan saved more than 90 days ago, even for a trip still ahead", () => {
    const savedAt = new Date(NOW.getTime() - 91 * DAY).toISOString();
    expectDiscarded(stored(record(fixturePlan(), { savedAt })), "stale");
    const recent = new Date(NOW.getTime() - 89 * DAY).toISOString();
    expect(readLastPlan(stored(record(fixturePlan(), { savedAt: recent })), ctx, NOW).status).toBe(
      "restored",
    );
  });

  it("discards a plan saved in the future (a changed clock or an edited value)", () => {
    const savedAt = new Date(NOW.getTime() + 2 * DAY).toISOString();
    expectDiscarded(stored(record(fixturePlan(), { savedAt })), "stale");
  });

  it("keeps a trip through its last day and discards it the day after", () => {
    // NOW is 2026-09-23; the trip's last day is TRIP_DAYS - 1 days after its start.
    const endsToday = fixturePlan({ startDate: addDays("2026-09-23", -(TRIP_DAYS - 1)) });
    expect(readLastPlan(stored(record(endsToday)), ctx, NOW).status).toBe("restored");
    const endedYesterday = fixturePlan({ startDate: addDays("2026-09-22", -(TRIP_DAYS - 1)) });
    expectDiscarded(stored(record(endedYesterday)), "stale");
  });
});

describe("plans that no longer match the data", () => {
  it("discards a plan naming a place that is no longer in the data", () => {
    const plan = fixturePlan();
    const gone = must(plan.days[0]?.stops[0], "first stop").placeId;
    const smaller = buildPlannerContext(places.filter((place) => place.id !== gone));
    const store = stored(record(plan));
    expect(readLastPlan(store, smaller, NOW)).toEqual({
      status: "discarded",
      reason: "data-changed",
    });
    expect(store.map.has(LAST_PLAN_KEY)).toBe(false);
  });

  it("discards a plan whose base is unknown", () => {
    const plan = fixturePlan();
    const days = plan.days.map((day, index) =>
      index === 1 ? { ...day, anchorId: "atlantis" } : day,
    );
    expectDiscarded(stored(record({ ...plan, days })), "data-changed");
  });

  it("restores a plan that now breaks a rule, flagged with a note, like an edit that broke one", () => {
    const plan = fixturePlan();
    const day0 = must(plan.days[0], "day 0");
    const [first, second, ...rest] = day0.stops;
    const overlap = { ...must(second, "second stop"), start: must(first, "first stop").start + 5 };
    overlap.end = Math.max(overlap.end, overlap.start + 30);
    const broken = {
      ...plan,
      days: [{ ...day0, stops: [must(first, "first"), overlap, ...rest] }, ...plan.days.slice(1)],
    };
    const read = readLastPlan(stored(record(broken)), ctx, NOW);
    expect(read.status).toBe("restored");
    if (read.status !== "restored") return;
    expect(read.flagged).toBeGreaterThan(0);
    expect(restoredNote(read.flagged)).toMatch(/no longer fit/);
    expect(restoredNote(0)).toBeNull();
  });
});
