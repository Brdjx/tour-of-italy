import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../lib/apiError";
import { loadTripData, summaryFor, type TripDataClient } from "../lib/tripData";
import { buildTripOptions, interestsFromPlaces } from "../lib/tripOptions";
import { useTripData } from "../lib/useTripData";
import { ctx, dataset, must, places, tripData } from "./fixtures";

// The page needs the places to plan; the meta and data notes are nice to have. A failure in
// either optional call must not stop planning, and a broken place list must not reach the
// planner.

const meta = {
  anchors: [
    { id: "rome", name: "Rome", placeCount: 30 },
    { id: "atlantis", name: "Atlantis", placeCount: 3 },
  ],
  interests: [
    { tag: "food", label: "Food and drink", count: 39 },
    { tag: "made-up", count: 2 },
  ],
};

function client(overrides: Partial<TripDataClient> = {}): TripDataClient {
  return {
    fetchMeta: async () => meta,
    fetchPlaces: async () => places,
    fetchDataIssues: async () => ({ summary: dataset.summary }),
    ...overrides,
  };
}

const fail = (kind: ApiError["kind"]) => async () => {
  throw new ApiError({ kind, message: "x" });
};

describe("loadTripData", () => {
  it("builds the planner context and form options from the loaded data", async () => {
    const data = await loadTripData(undefined, client());
    expect(data.ctx.places).toHaveLength(places.length);
    expect(data.options.interests[0]).toEqual({ tag: "food", label: "Food and drink", count: 39 });
    expect(data.summary).toBe(dataset.summary);
  });

  it("still loads when meta and data notes fail, rebuilding both from the places", async () => {
    const data = await loadTripData(
      undefined,
      client({ fetchMeta: fail("network"), fetchDataIssues: fail("schema") }),
    );
    expect(data.options.anchors.map((anchor) => anchor.id)).toEqual(
      ctx.anchors.map((anchor) => anchor.id),
    );
    expect(data.summary.items.length).toBeGreaterThan(0);
  });

  it("drops an unreadable saved copy of the places and asks once more, so a fixed API recovers", async () => {
    const forgetCached = vi.fn(async () => {});
    let calls = 0;
    const fetchPlaces = async () => {
      calls += 1;
      if (calls === 1) throw new ApiError({ kind: "schema", message: "stale copy" });
      return places;
    };
    const data = await loadTripData(undefined, client({ fetchPlaces, forgetCached }));
    expect(data.places).toBe(places);
    expect(forgetCached).toHaveBeenCalledWith(["/api/places"]);
    expect(calls).toBe(2);
  });

  it("asks only once more, and never for a network failure", async () => {
    const forgetCached = vi.fn(async () => {});
    const unreadable = vi.fn(fail("parse"));
    await expect(
      loadTripData(undefined, client({ fetchPlaces: unreadable, forgetCached })),
    ).rejects.toMatchObject({ kind: "parse" });
    expect(unreadable).toHaveBeenCalledTimes(2);
    const down = vi.fn(fail("network"));
    await expect(
      loadTripData(undefined, client({ fetchPlaces: down, forgetCached })),
    ).rejects.toMatchObject({ kind: "network" });
    expect(down).toHaveBeenCalledTimes(1);
  });

  it("drops an unreadable saved copy of the form data, which stays optional", async () => {
    const forgetCached = vi.fn(async () => {});
    const data = await loadTripData(undefined, client({ fetchMeta: fail("schema"), forgetCached }));
    expect(data.options.anchors.length).toBeGreaterThan(0);
    expect(forgetCached).toHaveBeenCalledWith(["/api/meta"]);
  });

  it("fails with the places error when the places cannot load", async () => {
    await expect(
      loadTripData(undefined, client({ fetchPlaces: fail("timeout") })),
    ).rejects.toMatchObject({ kind: "timeout" });
  });

  it("refuses an empty place list or one with a repeated id", async () => {
    await expect(
      loadTripData(undefined, client({ fetchPlaces: async () => [] })),
    ).rejects.toMatchObject({ kind: "schema" });
    const twice = [...places, must(places[0])];
    await expect(
      loadTripData(undefined, client({ fetchPlaces: async () => twice })),
    ).rejects.toMatchObject({ kind: "schema" });
  });

  it("passes the abort signal to every call", async () => {
    const fetchMeta = vi.fn(async () => meta);
    const controller = new AbortController();
    await loadTripData(controller.signal, client({ fetchMeta }));
    expect(fetchMeta).toHaveBeenCalledWith({ signal: controller.signal });
  });
});

describe("buildTripOptions", () => {
  it("never offers a base or interest the loaded places cannot plan with", () => {
    const options = buildTripOptions(ctx, meta);
    expect(options.anchors.map((anchor) => anchor.id)).toEqual(["rome"]);
    expect(options.interests.map((interest) => interest.tag)).toEqual(["food"]);
  });

  it("falls back to the places when meta and places share nothing", () => {
    const options = buildTripOptions(ctx, {
      anchors: [{ id: "atlantis", name: "A" }],
      interests: [],
    });
    expect(options.anchors).toHaveLength(ctx.anchors.length);
    expect(options.interests).toEqual(interestsFromPlaces(ctx));
  });

  it("counts interests from the places, most common first, without non-interest tags", () => {
    const interests = interestsFromPlaces(ctx);
    expect(interests.map((interest) => interest.tag)).not.toContain("tourist-heavy");
    for (let index = 1; index < interests.length; index++) {
      expect(must(interests[index - 1]).count).toBeGreaterThanOrEqual(must(interests[index]).count);
    }
    const options = buildTripOptions(ctx, null);
    expect(options.paces.map((pace) => pace.hint)).toEqual([
      "Up to 3 visits a day, plus lunch and dinner, 10:00 to 22:00",
      "Up to 5 visits a day, plus lunch and dinner, 09:30 to 22:30",
      "Up to 7 visits a day, plus lunch and dinner, 08:30 to 23:30",
    ]);
    expect(
      must(options.places[0]).name.localeCompare(must(options.places[1]).name),
    ).toBeLessThanOrEqual(0);
  });
});

describe("summaryFor", () => {
  it("prefers the API's summary, else rebuilds one from the issues sent or the places", () => {
    expect(summaryFor({ summary: dataset.summary }, places)).toBe(dataset.summary);
    const fromIssues = summaryFor({ issues: dataset.issues, excluded: [] }, places);
    expect(fromIssues.items.map((item) => item.kind)).toEqual(
      dataset.summary.items.map((item) => item.kind),
    );
    expect(summaryFor(null, places).totals.schedulable).toBe(places.length);
  });
});

describe("useTripData", () => {
  it("goes from loading to ready", async () => {
    const data = tripData();
    const { result } = renderHook(() => useTripData(async () => data));
    expect(result.current.state.status).toBe("loading");
    await waitFor(() => expect(result.current.state.status).toBe("ready"));
  });

  it("reports an error and loads again on retry", async () => {
    let calls = 0;
    const loader = async () => {
      calls += 1;
      if (calls === 1) throw new ApiError({ kind: "network", message: "x" });
      return tripData();
    };
    const { result } = renderHook(() => useTripData(loader));
    await waitFor(() => expect(result.current.state.status).toBe("error"));
    result.current.retry();
    await waitFor(() => expect(result.current.state.status).toBe("ready"));
  });

  it("ignores a response that arrives after unmount", async () => {
    let resolve: (value: ReturnType<typeof tripData>) => void = () => {};
    const loader = () => new Promise<ReturnType<typeof tripData>>((done) => (resolve = done));
    const { result, unmount } = renderHook(() => useTripData(loader));
    unmount();
    resolve(tripData());
    await Promise.resolve();
    expect(result.current.state.status).toBe("loading");
  });
});
