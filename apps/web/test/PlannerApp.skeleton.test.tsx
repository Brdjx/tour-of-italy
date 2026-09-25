import type { Itinerary, TripRequest } from "@italy/planner";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlannerApp } from "../components/PlannerApp";
import { ApiError } from "../lib/apiError";
import type { TripData } from "../lib/tripData";
import { SLOW_PLAN_MS, SLOW_PLAN_TEXT } from "../lib/usePlanTrip";
import { aiPlan, fixturePlan, must, tripData } from "./fixtures";

// Loading states (F8, F12): the page works from the first paint with skeletons where the data
// goes, the plan area shows the plan's skeleton while a plan is on its way (busy, announced,
// honest after 8 s), a failed request brings the previous plan back, and no skeleton is left
// once the real content is there.

vi.mock("../components/DayMap", () => ({
  DayMap: () => <div data-testid="day-map" />,
  prefetchMap: () => () => {},
}));

type Post = (request: TripRequest) => Promise<Itinerary>;
const TODAY = () => new Date(2026, 8, 23);

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function setup(post: Post, loader: () => Promise<TripData> = async () => tripData()) {
  const user = userEvent.setup();
  render(<PlannerApp loader={loader} post={post} today={TODAY} />);
  return user;
}

const planArea = () => must(document.getElementById("plan"), "the plan area");
const skeletons = () => document.querySelectorAll(".skeleton");
const stopIds = () => screen.getAllByTestId("stop-row").map((row) => row.dataset.placeId);

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("before the places arrive", () => {
  it("offers the date, the pace and Plan my trip at once, with skeletons only where data goes", async () => {
    const data = deferred<TripData>();
    const user = setup(
      async () => aiPlan(),
      () => data.promise,
    );
    expect((screen.getByTestId("start-date") as HTMLInputElement).value).toBe("2026-10-07");
    expect(screen.getByRole("radio", { name: "Balanced" })).toBeTruthy();
    expect(screen.getByTestId("plan-button").textContent).toBe("Plan my trip");
    const footer = must(document.querySelector("footer"), "footer");
    expect(footer.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByTestId("data-notes-skeleton").getAttribute("aria-hidden")).toBe("true");
    await user.click(screen.getByTestId("more-options-button"));
    expect(screen.getByTestId("interests-skeleton")).toBeTruthy();

    await act(async () => data.resolve(tripData()));
    expect(skeletons()).toHaveLength(0);
    expect(footer.hasAttribute("aria-busy")).toBe(false);
    expect(screen.getByTestId("data-notes")).toBeTruthy();
    expect(screen.getByTestId("interests-field").querySelectorAll("input")).not.toHaveLength(0);
  });

  it("plans before the places arrive, then checks that plan in this browser once they do", async () => {
    const data = deferred<TripData>();
    const plan = fixturePlan();
    const day0 = must(plan.days[0], "day 0");
    const [first, second, ...rest] = day0.stops;
    const start = must(first, "first stop").start + 5;
    const overlap = { ...must(second, "second stop"), start, end: start + 60 };
    const broken = { ...plan, days: [{ ...day0, stops: [must(first), overlap, ...rest] }] };
    const user = setup(
      async () => ({ ...broken, days: [...broken.days, ...plan.days.slice(1)] }),
      () => data.promise,
    );
    await user.click(screen.getByTestId("plan-button"));
    // The answer is in, but it cannot be shown or checked without the places.
    await waitFor(() =>
      expect(screen.getByTestId("planning-state").textContent).toContain("Opening"),
    );
    expect(screen.queryByTestId("stop-row")).toBeNull();
    await act(async () => data.resolve(tripData()));
    expect(await screen.findAllByTestId("stop-row")).not.toHaveLength(0);
    expect(document.querySelector('[data-flagged="true"]')).not.toBeNull();
    expect(screen.getByTestId("source-badge").textContent).not.toContain("checked against");
  });
});

describe("while a plan is on its way", () => {
  it("swaps the plan for its skeleton, marks the area busy, and draws the new plan in", async () => {
    const next = deferred<Itinerary>();
    const post = vi.fn<Post>().mockResolvedValueOnce(aiPlan()).mockReturnValueOnce(next.promise);
    const user = setup(post);
    await user.click(await screen.findByTestId("plan-button"));
    await screen.findAllByTestId("stop-row");
    expect(planArea().getAttribute("aria-busy")).toBe("false");

    await user.click(screen.getByTestId("edit-trip-button"));
    // Other options: the tab would show the first plan again from its memory, with no request.
    await user.click(screen.getByRole("radio", { name: "Packed" }));
    await user.click(screen.getByTestId("plan-button"));
    expect(planArea().getAttribute("aria-busy")).toBe("true");
    expect(within(planArea()).getByTestId("planning-state").textContent).toContain(
      "Planning your trip",
    );
    expect(screen.queryByTestId("plan-view")).toBeNull();
    expect(screen.getByTestId("skeleton-rows").children.length).toBeGreaterThanOrEqual(5);
    const button = screen.getByTestId("plan-button");
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.textContent).toBe("Planning your trip");
    expect(screen.getByTestId("live-region").textContent).toBe("Planning your trip.");
    for (const block of skeletons()) {
      expect(
        block.closest('[aria-hidden="true"]'),
        "a skeleton screen readers can reach",
      ).not.toBeNull();
    }

    await act(async () => next.resolve(aiPlan({ pace: "relaxed" })));
    expect(await screen.findByTestId("plan-view")).toBeTruthy();
    expect(planArea().getAttribute("aria-busy")).toBe("false");
    expect(screen.queryByTestId("planning-state")).toBeNull();
    expect(skeletons()).toHaveLength(0);
  });

  it("brings the previous plan back, under the error, when the next request fails", async () => {
    const next = deferred<Itinerary>();
    const post = vi.fn<Post>().mockResolvedValueOnce(aiPlan()).mockReturnValueOnce(next.promise);
    const user = setup(post);
    await user.click(await screen.findByTestId("plan-button"));
    await screen.findAllByTestId("stop-row");
    const before = stopIds();
    await user.click(screen.getByTestId("edit-trip-button"));
    // Other options: the tab would show the first plan again from its memory, with no request.
    await user.click(screen.getByRole("radio", { name: "Packed" }));
    await user.click(screen.getByTestId("plan-button"));
    expect(screen.queryByTestId("stop-row")).toBeNull();

    const refused = new ApiError({ kind: "http", status: 400, message: "x", details: [] });
    await act(async () => next.reject(refused));
    expect(await screen.findByTestId("error-state")).toBeTruthy();
    expect(stopIds()).toEqual(before);
    expect(planArea().getAttribute("aria-busy")).toBe("false");
    expect(screen.queryByTestId("planning-state")).toBeNull();
  });

  it("goes back to the form, with the error under it and focus on Plan my trip, when a first plan fails", async () => {
    const refused = new ApiError({ kind: "http", status: 400, message: "x", details: [] });
    const user = setup(async () => {
      throw refused;
    });
    await user.click(await screen.findByTestId("plan-button"));
    const error = await screen.findByTestId("error-state");
    expect(screen.getByTestId("planner-app").dataset.view).toBe("compose");
    expect(must(document.getElementById("trip-form-pane")).contains(error)).toBe(true);
    // The plan area that had focus is gone; focus is never left on the page itself.
    expect(document.activeElement).toBe(screen.getByTestId("plan-button"));
  });

  it("retries a plan the server could not make, before the places have loaded", async () => {
    const data = deferred<TripData>();
    const down = new ApiError({ kind: "http", status: 503, message: "x" });
    const post = vi.fn<Post>().mockRejectedValueOnce(down).mockResolvedValueOnce(aiPlan());
    const user = setup(post, () => data.promise);
    await user.click(screen.getByTestId("plan-button"));
    // No places yet, so no plan on this device: the error offers Try again.
    const error = await screen.findByTestId("error-state");
    await user.click(within(error).getByTestId("retry-button"));
    expect(post).toHaveBeenCalledTimes(2);
    await act(async () => data.resolve(tripData()));
    expect(await screen.findAllByTestId("stop-row")).not.toHaveLength(0);
  });

  it("adds the honest line after 8 seconds, on screen and for screen readers", async () => {
    const next = deferred<Itinerary>();
    setup(() => next.promise);
    await screen.findByTestId("data-notes");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.submit(screen.getByTestId("trip-form"));
    expect(screen.getByTestId("planning-detail")).toBeTruthy();
    await act(async () => vi.advanceTimersByTime(SLOW_PLAN_MS - 1));
    expect(screen.queryByTestId("planning-slow")).toBeNull();
    await act(async () => vi.advanceTimersByTime(1));
    expect(screen.getByTestId("planning-slow").textContent).toBe(SLOW_PLAN_TEXT);
    expect(screen.getByTestId("live-region").textContent).toBe(SLOW_PLAN_TEXT);
    // The line takes the explanation's place, so nothing below it moves.
    expect(screen.queryByTestId("planning-detail")).toBeNull();
    await act(async () => next.resolve(aiPlan()));
    expect(screen.queryByTestId("planning-slow")).toBeNull();
    expect(screen.getByTestId("live-region").textContent).toBe("Your plan is ready.");
  });

  it("never shows the honest line for a plan that answers in time", async () => {
    const next = deferred<Itinerary>();
    setup(() => next.promise);
    await screen.findByTestId("data-notes");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.submit(screen.getByTestId("trip-form"));
    await act(async () => next.resolve(aiPlan()));
    await act(async () => vi.advanceTimersByTime(SLOW_PLAN_MS * 2));
    expect(screen.getByTestId("live-region").textContent).toBe("Your plan is ready.");
  });
});
