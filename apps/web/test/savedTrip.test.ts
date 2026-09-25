import { dataVersion, type Itinerary, type PlannerContext } from "@italy/planner";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../lib/apiError";
import type { SavedTripResponse } from "../lib/apiSchemas";
import {
  type LoadedTrip,
  loadSavedTrip,
  openSavedTrip,
  readTripParam,
  SAVED_NOTES,
  saveTripBody,
} from "../lib/savedTrip";
import { aiPlan, ctx, GENERATED_AT } from "./fixtures";

// Saved trips on the page: the body Copy link sends, reading ?t=, fetching the trip, and what
// the page shows for it: the trip as saved, the trip timed again when the place data changed,
// or a plain note.

const ID = "a1B2c3D4e5";

function savedTrip(overrides: Partial<SavedTripResponse> = {}): SavedTripResponse {
  const { planId: _planId, ...itinerary } = aiPlan();
  return {
    v: 1,
    id: ID,
    // The planner's Itinerary type allows error warnings; the schema's output does not.
    itinerary: itinerary as SavedTripResponse["itinerary"],
    origin: { plannedBy: "ai", edited: false },
    dataVersion: dataVersion(ctx.places),
    createdAt: "2026-09-20T18:30:00.000Z",
    ...overrides,
  };
}

const found = (trip = savedTrip()): LoadedTrip => ({ kind: "found", trip });

describe("saveTripBody", () => {
  it("sends the request without notes, each day's base and ids in order, and the planId", () => {
    const plan = { ...aiPlan({ notes: "Private." }), planId: "Zz9Yy8Xx7W" };

    const body = saveTripBody(plan, ID);

    expect(body.request.notes).toBeUndefined();
    expect(body.days).toEqual(
      plan.days.map((day) => ({ anchorId: day.anchorId, ids: day.stops.map((s) => s.placeId) })),
    );
    // The plan's own record wins over the saved trip it may have been opened from.
    expect(body.planId).toBe("Zz9Yy8Xx7W");
    expect(body).not.toHaveProperty("tripId");
    expect(JSON.stringify(body)).not.toContain("reason");
  });

  it("names the saved trip a plan was opened from, and nothing for a plan with no record", () => {
    const plan = aiPlan();
    expect(saveTripBody(plan, ID)).toMatchObject({ tripId: ID });
    const bare = saveTripBody(plan);
    expect(bare).not.toHaveProperty("tripId");
    expect(bare).not.toHaveProperty("planId");
  });
});

describe("readTripParam", () => {
  it("reads ?t= and copes with no value", () => {
    expect(readTripParam(`?t=${ID}`)).toBe(ID);
    expect(readTripParam("?p=abc")).toBeNull();
    expect(readTripParam("")).toBeNull();
  });
});

describe("loadSavedTrip", () => {
  it("fetches a trip with a well-formed id", async () => {
    const fetchTrip = vi.fn(async () => savedTrip());
    expect(await loadSavedTrip(ID, fetchTrip)).toEqual(found());
    expect(fetchTrip).toHaveBeenCalledWith(ID);
  });

  it("calls an id that cannot be one missing, without asking the server", async () => {
    const fetchTrip = vi.fn(async () => savedTrip());
    for (const id of ["", "short", "a1B2c3D4e5f", "../../api/x", "a1B2c3D4e!"]) {
      expect(await loadSavedTrip(id, fetchTrip)).toEqual({ kind: "missing" });
    }
    expect(fetchTrip).not.toHaveBeenCalled();
  });

  it("tells a missing trip (404) apart from a failed load", async () => {
    const failing = (error: ApiError) => loadSavedTrip(ID, () => Promise.reject(error));

    expect(await failing(new ApiError({ kind: "http", status: 404, message: "x" }))).toEqual({
      kind: "missing",
    });
    for (const error of [
      new ApiError({ kind: "network", message: "x" }),
      new ApiError({ kind: "timeout", message: "x" }),
      new ApiError({ kind: "http", status: 503, message: "x" }),
      new ApiError({ kind: "schema", message: "x" }),
    ]) {
      expect(await failing(error)).toEqual({ kind: "failed" });
    }
    expect(await loadSavedTrip(ID, () => Promise.reject(new Error("odd")))).toEqual({
      kind: "failed",
    });
  });
});

describe("openSavedTrip", () => {
  it("shows the trip exactly as saved when this page has the same place data", () => {
    const trip = savedTrip({ origin: { plannedBy: "ai_repaired", edited: true } });

    const result = openSavedTrip(found(trip), ctx, GENERATED_AT);

    expect(result).toEqual({
      status: "plan",
      itinerary: trip.itinerary,
      saved: {
        id: ID,
        createdAt: trip.createdAt,
        plannedBy: "ai_repaired",
        edited: true,
        retimed: false,
      },
      note: null,
    });
  });

  it("times the trip again from its ids when the place data changed, and says so", () => {
    const trip = savedTrip({ dataVersion: "0123456789abcdef" });

    const result = openSavedTrip(found(trip), ctx, GENERATED_AT);

    if (result.status !== "plan") throw new Error(`expected a plan, got ${result.status}`);
    expect(result.note).toContain(SAVED_NOTES.retimed);
    expect(result.saved.retimed).toBe(true);
    expect(result.itinerary.source).toBe("deterministic");
    const ids = (plan: Pick<Itinerary, "days">) =>
      plan.days.map((d) => d.stops.map((s) => s.placeId));
    expect(ids(result.itinerary)).toEqual(ids(trip.itinerary));
    const stops = result.itinerary.days.flatMap((day) => day.stops);
    expect(stops.every((stop) => stop.reasonSource === "rule")).toBe(true);
  });

  it("fills in the settings when the trip no longer fits the current data", () => {
    const trip = savedTrip({ dataVersion: "0123456789abcdef" });
    trip.itinerary.days = trip.itinerary.days.map((day) => ({ ...day, anchorId: "atlantis" }));

    const result = openSavedTrip(found(trip), ctx, GENERATED_AT);

    expect(result).toMatchObject({ status: "request", note: SAVED_NOTES.stale });
  });

  it("says a trip could not be opened when the planner cannot rebuild it", () => {
    const broken = { ...ctx, places: null } as unknown as PlannerContext;

    const result = openSavedTrip(found(), broken, GENERATED_AT);

    expect(result).toEqual({ status: "invalid", note: SAVED_NOTES.damaged, keepLink: false });
  });

  it("notes a missing trip and a failed load, keeping the link only for the failed load", () => {
    expect(openSavedTrip({ kind: "missing" }, ctx, GENERATED_AT)).toEqual({
      status: "invalid",
      note: SAVED_NOTES.notFound,
      keepLink: false,
    });
    expect(openSavedTrip({ kind: "failed" }, ctx, GENERATED_AT)).toEqual({
      status: "invalid",
      note: SAVED_NOTES.failed,
      keepLink: true,
    });
  });
});
