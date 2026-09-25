import { dataVersion } from "@italy/planner";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SavedTripResponse } from "../lib/apiSchemas";
import { useSavedTripOnLoad } from "../lib/useSavedTrip";
import { useSharedLinkOnLoad } from "../lib/useSharedLink";
import { aiPlan, ctx, places } from "./fixtures";

// Giving up a link that has not opened yet: the traveler planned a trip of their own first, so
// the link never opens over it and its parameter leaves the address bar. The page-level cases
// are in PlannerApp.savedTrip.test.tsx; these cover the moments the page cannot reach on its own.

const ID = "a1B2c3D4e5";

function savedTrip(): SavedTripResponse {
  return {
    v: 1,
    id: ID,
    itinerary: aiPlan() as SavedTripResponse["itinerary"],
    origin: { plannedBy: "ai", edited: false },
    dataVersion: dataVersion(places),
    createdAt: "2026-09-20T12:00:00.000Z",
  };
}

beforeEach(() => window.history.replaceState(null, "", "/"));
afterEach(cleanup);

describe("useSavedTripOnLoad", () => {
  it("never opens a trip given up while it was still loading", async () => {
    window.history.replaceState(null, "", `/?t=${ID}`);
    let answer: (trip: SavedTripResponse) => void = () => {};
    const fetchTrip = () => new Promise<SavedTripResponse>((resolve) => (answer = resolve));
    const onOpen = vi.fn();
    const { result } = renderHook(() => useSavedTripOnLoad(ctx, onOpen, fetchTrip));
    expect(result.current.pending).toBe(true);

    let dropped = false;
    act(() => {
      dropped = result.current.drop();
    });
    await act(async () => answer(savedTrip()));

    expect(dropped).toBe(true);
    expect(onOpen).not.toHaveBeenCalled();
    expect(result.current.pending).toBe(false);
    expect(window.location.search).toBe("");
    expect(result.current.drop()).toBe(false); // once is enough
  });

  it("has nothing to give up once the trip has opened, or without a link", async () => {
    window.history.replaceState(null, "", `/?t=${ID}`);
    const onOpen = vi.fn();
    const fetchTrip = async () => savedTrip();
    const { result } = renderHook(() => useSavedTripOnLoad(ctx, onOpen, fetchTrip));
    await waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1));
    expect(result.current.drop()).toBe(false);
    cleanup();

    window.history.replaceState(null, "", "/");
    const none = renderHook(() => useSavedTripOnLoad(null, onOpen, fetchTrip));
    expect(none.result.current.drop()).toBe(false);
  });
});

describe("useSharedLinkOnLoad", () => {
  it("gives up a ?p= link before the places load, and says whether there was one", () => {
    window.history.replaceState(null, "", "/?p=abc&mode=deterministic");
    const onOpen = vi.fn();
    const { result, rerender } = renderHook(
      ({ loaded }) => useSharedLinkOnLoad(loaded ? ctx : null, onOpen),
      { initialProps: { loaded: false } },
    );

    expect(result.current()).toBe(true);
    rerender({ loaded: true });

    expect(onOpen).not.toHaveBeenCalled();
    expect(window.location.search).toBe("?mode=deterministic"); // only ?p= goes
    expect(result.current()).toBe(false);
  });

  it("has nothing to give up without a link", () => {
    const { result } = renderHook(() => useSharedLinkOnLoad(null, vi.fn()));
    expect(result.current()).toBe(false);
  });
});
