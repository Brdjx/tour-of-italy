import type { Itinerary, TripRequest } from "@italy/planner";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OPTIONS_FAILED } from "../components/form/MoreOptions";
import { PlannerApp } from "../components/PlannerApp";
import { PLACES_MISSING } from "../components/PlanPane";
import { ApiError } from "../lib/apiError";
import { LAST_PLAN_KEY } from "../lib/lastPlan";
import { encodeShare } from "../lib/shareLink";
import type { TripData } from "../lib/tripData";
import { aiPlan, fixturePlan, must, tripData } from "./fixtures";

// The page's two shapes: one calm column before a plan, then the plan with the form folded into
// a summary line. The fold must keep what the traveler set, a shared or saved plan must open
// straight into the plan view, and a page whose places failed must still plan.

vi.mock("../components/DayMap", () => ({
  DayMap: () => <div data-testid="day-map" />,
  prefetchMap: () => () => {},
}));

type Post = (request: TripRequest) => Promise<Itinerary>;
const TODAY = () => new Date(2026, 8, 23);
const echo: Post = async (request) => aiPlan(request);

function setup(post: Post = echo, loader: () => Promise<TripData> = async () => tripData()) {
  const user = userEvent.setup();
  render(<PlannerApp loader={loader} post={post} today={TODAY} />);
  return user;
}

const view = () => screen.getByTestId("planner-app").dataset.view;
const formFolded = () => must(document.getElementById("trip-form-body"), "form body").hidden;

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  window.localStorage.clear();
});

afterEach(cleanup);

describe("the calm first screen", () => {
  it("is one column with the title, one line, and no plan area until a plan is asked for", async () => {
    setup();
    await screen.findByTestId("data-notes");
    expect(view()).toBe("compose");
    expect(screen.getByTestId("app-tagline").textContent).toBe(
      "Three days planned around real opening hours and travel time.",
    );
    expect(document.getElementById("plan")).toBeNull();
    expect(screen.queryByRole("link", { name: "Skip to your plan" })).toBeNull();
    expect(formFolded()).toBe(false);
  });
});

describe("the folded form", () => {
  it("folds into the summary of what is being planned, then of the plan on screen", async () => {
    let answer: (plan: Itinerary) => void = () => {};
    const user = setup(() => new Promise<Itinerary>((resolve) => (answer = resolve)));
    await user.click(await screen.findByTestId("more-options-button"));
    const interests = within(screen.getByTestId("interests-field")).getAllByRole("checkbox");
    await user.click(interests[0] as HTMLElement);
    await user.click(screen.getByTestId("plan-button"));
    expect(view()).toBe("plan");
    expect(formFolded()).toBe(true);
    expect(screen.getByTestId("trip-summary-text").textContent).toBe(
      "Your trip: Wed 7 Oct to Fri 9 Oct, balanced pace, 1 option",
    );
    expect(document.activeElement).toBe(document.getElementById("plan"));
    await act(async () => answer(aiPlan({ startDate: "2026-10-20", pace: "packed" })));
    await screen.findAllByTestId("stop-row");
    expect(screen.getByTestId("trip-summary-text").textContent).toBe(
      "Your trip: Tue 20 Oct to Thu 22 Oct, packed pace, 1 option",
    );
  });

  it("opens again with Edit trip exactly as the traveler left it, More options included", async () => {
    const user = setup();
    await user.click(await screen.findByTestId("more-options-button"));
    const first = within(screen.getByTestId("interests-field")).getAllByRole("checkbox")[0];
    await user.click(first as HTMLElement);
    await user.click(screen.getByTestId("plan-button"));
    await screen.findAllByTestId("stop-row");
    await user.click(screen.getByTestId("edit-trip-button"));
    expect(formFolded()).toBe(false);
    expect(screen.getByTestId("more-options-button").getAttribute("aria-expanded")).toBe("true");
    expect((first as HTMLInputElement).checked).toBe(true);
    expect(screen.getByTestId("options-count").textContent).toBe("1 set");
    await user.click(screen.getByTestId("back-to-plan"));
    expect(formFolded()).toBe(true);
    expect(document.activeElement).toBe(screen.getByTestId("edit-trip-button"));
  });

  it("hides the edit toast while the form, with its sticky Plan my trip bar, is open", async () => {
    const user = setup();
    await user.click(await screen.findByTestId("plan-button"));
    const row = (await screen.findAllByTestId("stop-row"))[0] as HTMLElement;
    await user.click(within(row).getByTestId("remove-button"));
    expect(screen.getByTestId("toast")).toBeTruthy();
    await user.click(screen.getByTestId("edit-trip-button"));
    expect(screen.queryByTestId("toast")).toBeNull();
  });
});

describe("plans that open on their own", () => {
  it("opens a shared link straight into the plan, with the form folded", async () => {
    const plan = fixturePlan({ pace: "relaxed" });
    window.history.replaceState(null, "", `/?p=${encodeShare(plan)}`);
    setup();
    await screen.findAllByTestId("stop-row");
    expect(view()).toBe("plan");
    expect(formFolded()).toBe(true);
    expect(screen.getByTestId("trip-summary-text").textContent).toContain("relaxed pace");
  });

  it("shows the plan's skeleton, not the form, while a saved plan waits for the places", async () => {
    const saved = { v: 1, savedAt: TODAY().toISOString(), origin: "api", itinerary: fixturePlan() };
    window.localStorage.setItem(LAST_PLAN_KEY, JSON.stringify(saved));
    let release: (data: TripData) => void = () => {};
    setup(echo, () => new Promise<TripData>((resolve) => (release = resolve)));
    expect(view()).toBe("plan");
    expect(screen.getByTestId("planning-state").textContent).toContain("Opening your plan");
    expect(screen.getByTestId("trip-summary-skeleton")).toBeTruthy();
    expect(document.documentElement.hasAttribute("data-expect-plan")).toBe(false);
    await act(async () => release(tripData()));
    expect(await screen.findAllByTestId("stop-row")).not.toHaveLength(0);
    expect(screen.queryByTestId("planning-state")).toBeNull();
  });

  it("falls back to the first screen when the saved plan turns out to be unusable", async () => {
    window.localStorage.setItem(LAST_PLAN_KEY, "{damaged");
    setup();
    expect(view()).toBe("plan");
    await waitFor(() => expect(view()).toBe("compose"));
    expect(formFolded()).toBe(false);
    expect(window.localStorage.getItem(LAST_PLAN_KEY)).toBeNull();
  });
});

describe("when the places cannot load", () => {
  it("says so under More options, still plans, and shows the plan once the places load", async () => {
    let calls = 0;
    const loader = async () => {
      calls += 1;
      if (calls <= 2) throw new ApiError({ kind: "http", status: 503, message: "x" });
      return tripData();
    };
    const user = setup(echo, loader);
    const error = await screen.findByTestId("options-error");
    expect(error.textContent).toContain(OPTIONS_FAILED);
    await user.click(screen.getByTestId("plan-button"));
    // The plan came back, but without the places it cannot be drawn: say so, offer a retry.
    expect((await screen.findByTestId("error-state")).textContent).toContain(PLACES_MISSING);
    await user.click(screen.getByTestId("retry-button"));
    expect(await screen.findByTestId("error-state")).toBeTruthy();
    await user.click(screen.getByTestId("retry-button"));
    expect(await screen.findAllByTestId("stop-row")).not.toHaveLength(0);
    expect(screen.queryByTestId("options-error")).toBeNull();
  });
});
