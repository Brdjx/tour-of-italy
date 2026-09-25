import type { Itinerary, TripRequest } from "@italy/planner";
import { cleanup, configure, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlannerApp, STARTED_OVER } from "../components/PlannerApp";
import { ApiError } from "../lib/apiError";
import { LAST_PLAN_KEY } from "../lib/lastPlan";
import { encodeShare } from "../lib/shareLink";
import { aiPlan, fixturePlan, must, tripData } from "./fixtures";

// The last plan on the real page: a reopened app shows it at once, every change is saved, a
// shared link still wins, a damaged or stale value never breaks the page, and "Start a new
// trip" forgets it.

vi.mock("../components/DayMap", () => ({
  DayMap: () => <div data-testid="day-map" />,
  prefetchMap: () => () => {},
}));

// Decision: generous waits. Each test loads and plans with the real data, and `pnpm check` runs
// every project in parallel; a slow machine must not turn into a failing test.
configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 20_000 });

const TODAY = () => new Date(2026, 8, 23);
type Post = (request: TripRequest) => Promise<Itinerary>;

function save(itinerary: Itinerary, origin = "api", savedAt = TODAY().toISOString()) {
  window.localStorage.setItem(LAST_PLAN_KEY, JSON.stringify({ v: 1, savedAt, origin, itinerary }));
}

function saved(): { origin: string; cause?: string; itinerary: Itinerary } | null {
  const raw = window.localStorage.getItem(LAST_PLAN_KEY);
  return raw ? JSON.parse(raw) : null;
}

function setup(post: Post = async () => aiPlan()) {
  const user = userEvent.setup();
  render(<PlannerApp loader={async () => tripData()} post={post} today={TODAY} />);
  return { user };
}

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  window.localStorage.clear();
});

afterEach(cleanup);

describe("PlannerApp last plan", () => {
  it("shows the saved plan when the app reopens, with who planned it and the form filled in", async () => {
    const plan = fixturePlan({ pace: "packed", notes: "No early starts" });
    save(plan, "offline");
    setup();
    const rows = await screen.findAllByTestId("stop-row");
    expect(rows[0]?.dataset.placeId).toBe(plan.days[0]?.stops[0]?.placeId);
    // No cause was saved with this plan, so it says where it was built, not why.
    expect(screen.getByTestId("source-badge").textContent).toContain(
      "Planned without AI, on this device",
    );
    await waitFor(() =>
      expect(screen.getByTestId("live-region").textContent).toBe("Showing your last plan."),
    );
    expect(screen.queryByTestId("share-notice")).toBeNull();
    const notes = screen.getByLabelText(/Anything else/) as HTMLTextAreaElement;
    expect(notes.value).toBe("No early starts");
  });

  it("saves a new plan so the next visit can show it", async () => {
    const { user } = setup(async () => aiPlan());
    await user.click(await screen.findByTestId("plan-button"));
    await screen.findAllByTestId("stop-row");
    const stored = must(saved(), "saved plan");
    expect(stored.origin).toBe("api");
    expect(stored.itinerary.source).toBe("ai");
  });

  it("saves the offline plan with its offline origin", async () => {
    const { user } = setup(async () => {
      throw new ApiError({ kind: "network", message: "down" });
    });
    await user.click(await screen.findByTestId("plan-button"));
    await screen.findAllByTestId("stop-row");
    expect(must(saved(), "saved plan").origin).toBe("offline");
    expect(must(saved(), "saved plan").cause).toBe("offline");
  });

  it("saves every edit, so a reload does not bring back a removed stop", async () => {
    const plan = fixturePlan();
    save(plan);
    const { user } = setup();
    const first = (await screen.findAllByTestId("stop-row"))[0] as HTMLElement;
    await user.click(within(first).getByTestId("remove-button"));
    const day0 = must(saved()?.itinerary.days[0], "saved day");
    expect(day0.stops.map((stop) => stop.placeId)).not.toContain(plan.days[0]?.stops[0]?.placeId);
  });

  it("opens a shared link instead of the saved plan", async () => {
    save(fixturePlan({ pace: "relaxed" }));
    const shared = fixturePlan({ pace: "packed" });
    window.history.replaceState(null, "", `/?p=${encodeShare(shared)}`);
    setup();
    expect((await screen.findByTestId("share-notice")).textContent).toContain(
      "Opened a shared plan.",
    );
    const rows = screen.getAllByTestId("stop-row");
    expect(rows[0]?.dataset.placeId).toBe(shared.days[0]?.stops[0]?.placeId);
  });

  it("starts empty and clears the value when the saved plan is damaged", async () => {
    window.localStorage.setItem(LAST_PLAN_KEY, "{damaged");
    setup();
    expect(await screen.findByTestId("trip-form")).toBeTruthy();
    // The value is removed once the places load and it is checked; only then is "no plan" final.
    await waitFor(() => expect(window.localStorage.getItem(LAST_PLAN_KEY)).toBeNull());
    expect(screen.queryByTestId("stop-row")).toBeNull();
    await waitFor(() => expect(screen.getByTestId("planner-app").dataset.view).toBe("compose"));
  });

  it("starts empty when the saved trip is already over", async () => {
    save(fixturePlan({ startDate: "2026-09-01" }));
    setup();
    expect(await screen.findByTestId("trip-form")).toBeTruthy();
    // The value is removed once the places load and it is checked; only then is "no plan" final.
    await waitFor(() => expect(window.localStorage.getItem(LAST_PLAN_KEY)).toBeNull());
    expect(screen.queryByTestId("stop-row")).toBeNull();
    await waitFor(() => expect(screen.getByTestId("planner-app").dataset.view).toBe("compose"));
  });

  it("says so when the saved plan now breaks a rule, and marks the stop", async () => {
    const plan = fixturePlan();
    const day0 = must(plan.days[0], "day 0");
    const [first, second, ...rest] = day0.stops;
    const start = must(first, "first stop").start + 5;
    const overlap = { ...must(second, "second stop"), start, end: start + 60 };
    save({
      ...plan,
      days: [{ ...day0, stops: [must(first, "first"), overlap, ...rest] }, ...plan.days.slice(1)],
    });
    setup();
    expect((await screen.findByTestId("share-notice")).textContent).toContain("no longer fit");
    const flagged = screen
      .getAllByTestId("stop-row")
      .filter((row) => row.dataset.flagged === "true");
    expect(flagged.length).toBeGreaterThan(0);
  });
});

describe("Start a new trip", () => {
  const startOver = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByTestId("edit-trip-button"));
    await user.click(screen.getByTestId("start-over-button"));
  };

  it("forgets the saved plan and brings back the first screen with the default values", async () => {
    save(fixturePlan({ pace: "packed", notes: "No early starts" }));
    const { user } = setup();
    await screen.findAllByTestId("stop-row");
    expect(saved()).not.toBeNull();
    await startOver(user);
    expect(screen.getByTestId("planner-app").dataset.view).toBe("compose");
    expect(saved()).toBeNull();
    expect(screen.queryByTestId("stop-row")).toBeNull();
    expect((screen.getByTestId("start-date") as HTMLInputElement).value).toBe("2026-10-07");
    expect((screen.getByRole("radio", { name: "Balanced" }) as HTMLInputElement).checked).toBe(
      true,
    );
    expect(screen.queryByTestId("options-count")).toBeNull();
    expect(screen.getByTestId("live-region").textContent).toBe(STARTED_OVER);
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "3 Days in Italy" }));
    // The next plan is saved as usual.
    await user.click(screen.getByTestId("plan-button"));
    await screen.findAllByTestId("stop-row");
    expect(must(saved(), "saved plan").itinerary.request.pace).toBe("balanced");
  });

  it("drops the shared-link note and the shared plan", async () => {
    window.history.replaceState(null, "", `/?p=${encodeShare(fixturePlan({ pace: "relaxed" }))}`);
    const { user } = setup();
    await screen.findByTestId("share-notice");
    await startOver(user);
    expect(screen.queryByTestId("share-notice")).toBeNull();
    expect(screen.queryByTestId("stop-row")).toBeNull();
    expect(saved()).toBeNull();
    expect(screen.getByRole("radio", { name: "Balanced" })).toHaveProperty("checked", true);
  });

  it("leaves a failed request's message behind with the old plan", async () => {
    const post = vi
      .fn<Post>()
      .mockResolvedValueOnce(aiPlan())
      .mockRejectedValueOnce(
        new ApiError({ kind: "http", status: 400, message: "x", details: [{ path: ["pace"] }] }),
      );
    const { user } = setup(post);
    await user.click(await screen.findByTestId("plan-button"));
    await screen.findAllByTestId("stop-row");
    await user.click(screen.getByTestId("edit-trip-button"));
    await user.click(screen.getByTestId("plan-button"));
    expect(await screen.findByTestId("error-state")).toBeTruthy();
    await startOver(user);
    expect(screen.getByTestId("planner-app").dataset.view).toBe("compose");
    expect(screen.queryByTestId("error-state")).toBeNull();
  });

  it("is not offered while a plan is on its way", async () => {
    const { user } = setup(() => new Promise<Itinerary>(() => {}));
    await user.click(await screen.findByTestId("plan-button"));
    await user.click(screen.getByTestId("edit-trip-button"));
    expect(screen.queryByTestId("start-over-button")).toBeNull();
  });
});
