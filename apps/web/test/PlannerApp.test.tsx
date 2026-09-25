import type { Itinerary, TripRequest } from "@italy/planner";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlannerApp } from "../components/PlannerApp";
import { ApiError } from "../lib/apiError";
import { encodeShare } from "../lib/shareLink";
import type { TripData } from "../lib/tripData";
import { aiPlan, fixturePlan, tripData, XSS } from "./fixtures";

// The page as a whole (F8, F9, F12 at component level): loading, planning, plan, error with the
// previous plan kept, offline fallback, shared links, and edits with undo.

vi.mock("../components/DayMap", () => ({
  DayMap: () => <div data-testid="day-map" />,
  prefetchMap: () => () => {},
}));

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  // Plans are saved to localStorage; each test starts without one (see PlannerApp.lastPlan.test).
  window.localStorage.clear();
});

afterEach(cleanup);

type Post = (request: TripRequest) => Promise<Itinerary>;

function setup(post: Post, loader: () => Promise<TripData> = async () => tripData()) {
  const user = userEvent.setup();
  render(<PlannerApp loader={loader} post={post} today={() => new Date(2026, 8, 23)} />);
  return { user };
}

async function planOnce(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByTestId("plan-button"));
  await screen.findAllByTestId("stop-row");
}

describe("PlannerApp", () => {
  it("shows the form from the first render and the data notes once the places load", async () => {
    setup(async () => aiPlan());
    expect(screen.getByTestId("trip-form")).toBeTruthy();
    expect(screen.getByTestId("plan-button")).toBeTruthy();
    expect(screen.getByTestId("data-notes-skeleton")).toBeTruthy();
    expect(await screen.findByTestId("data-notes")).toBeTruthy();
    expect(screen.queryByTestId("data-notes-skeleton")).toBeNull();
    expect(screen.queryByTestId("plan-view")).toBeNull();
  });

  it("plans a trip and shows three day tabs, the timetable, and who planned it", async () => {
    const { user } = setup(async () => aiPlan());
    await planOnce(user);
    expect(screen.getAllByRole("tab")).toHaveLength(3);
    expect(screen.getByTestId("source-badge").textContent).toContain("Planned with AI");
    expect(screen.getByTestId("plan-summary").textContent).toBe("Three days of food in Rome.");
    expect(screen.getByTestId("live-region").textContent).toBe("Your plan is ready.");
    await user.click(screen.getByTestId("day-tab-2"));
    expect(screen.getByTestId("day-timetable").dataset.day).toBe("2");
  });

  it("says it is planning while the request is in flight", async () => {
    let finish: (plan: Itinerary) => void = () => {};
    const { user } = setup(() => new Promise<Itinerary>((resolve) => (finish = resolve)));
    await user.click(await screen.findByTestId("plan-button"));
    expect(screen.getByTestId("plan-button").textContent).toBe("Planning your trip");
    expect(screen.getByTestId("planning-state")).toBeTruthy();
    await act(async () => finish(aiPlan()));
    expect(await screen.findAllByTestId("stop-row")).not.toHaveLength(0);
  });

  it("keeps the previous plan on screen when the next request fails", async () => {
    const post = vi
      .fn<Post>()
      .mockResolvedValueOnce(aiPlan())
      .mockRejectedValueOnce(
        new ApiError({ kind: "http", status: 400, message: "x", details: [{ path: ["pace"] }] }),
      );
    const { user } = setup(post);
    await planOnce(user);
    const before = screen.getAllByTestId("stop-row").length;
    await user.click(screen.getByTestId("edit-trip-button"));
    // Other options: the tab would show the first plan again from its memory, with no request.
    await user.click(screen.getByRole("radio", { name: "Packed" }));
    await user.click(screen.getByTestId("plan-button"));
    const error = await screen.findByTestId("error-state");
    expect(error.textContent).toContain("Check the pace, then try again.");
    expect(within(error).queryByTestId("retry-button")).toBeNull();
    expect(screen.getAllByTestId("stop-row")).toHaveLength(before);
  });

  it("shows a plan for options this tab already planned at once, with no request and the same words", async () => {
    // The API answers the request it was sent, as the memo's plans always do.
    const post = vi.fn<Post>(async (request) => aiPlan(request));
    const { user } = setup(post);
    await planOnce(user);
    const first = screen.getAllByTestId("stop-row").map((row) => row.dataset.placeId);
    const badge = screen.getByTestId("source-badge").textContent;
    await user.click(screen.getByTestId("edit-trip-button"));
    await user.click(screen.getByRole("radio", { name: "Packed" }));
    await user.click(screen.getByTestId("plan-button"));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    await screen.findAllByTestId("stop-row");

    await user.click(screen.getByTestId("edit-trip-button"));
    await user.click(screen.getByRole("radio", { name: "Balanced" }));
    await user.click(screen.getByTestId("plan-button"));

    await waitFor(() =>
      expect(screen.getAllByTestId("stop-row").map((row) => row.dataset.placeId)).toEqual(first),
    );
    expect(post).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("source-badge").textContent).toBe(badge);
    expect(screen.getByTestId("live-region").textContent).toBe("Your plan is ready.");
    expect(screen.queryByTestId("share-notice")).toBeNull();
    // Focus lands on the day heading, as after a plan from the API.
    expect(document.activeElement).toBe(document.getElementById("day-heading-0"));
  });

  it("shows the plan as the API sent it, not as it was edited, when the same options are planned again", async () => {
    const post = vi.fn<Post>(async (request) => aiPlan(request));
    const { user } = setup(post);
    await planOnce(user);
    const first = screen.getAllByTestId("stop-row").map((row) => row.dataset.placeId);
    await user.click(
      within(screen.getAllByTestId("stop-row")[0] as HTMLElement).getByTestId("remove-button"),
    );
    expect(screen.getAllByTestId("stop-row")).toHaveLength(first.length - 1);

    await user.click(screen.getByTestId("edit-trip-button"));
    await user.click(screen.getByTestId("plan-button"));

    await waitFor(() =>
      expect(screen.getAllByTestId("stop-row").map((row) => row.dataset.placeId)).toEqual(first),
    );
    expect(post).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("source-badge").textContent).not.toContain("edited by you");
    expect(screen.getByTestId("source-badge").textContent).not.toContain("to fix");
  });

  it("asks the API again for options whose plan fell back to rules", async () => {
    const fallback = {
      ...fixturePlan(),
      meta: { ...fixturePlan().meta, fallbackReason: "timeout" as const },
    };
    const post = vi.fn<Post>(async () => fallback);
    const { user } = setup(post);
    await planOnce(user);

    await user.click(screen.getByTestId("edit-trip-button"));
    await user.click(screen.getByTestId("plan-button"));

    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
  });

  it("builds the plan in the browser and labels it offline when the API is unreachable", async () => {
    const { user } = setup(async () => {
      throw new ApiError({ kind: "network", message: "x" });
    });
    await planOnce(user);
    expect(screen.getByTestId("offline-label").textContent).toBe("Planned without AI, offline");
    expect(screen.queryByTestId("error-state")).toBeNull();
  });

  it("says the options could not load, keeps Plan my trip, and loads them on Try again", async () => {
    let calls = 0;
    const loader = async () => {
      calls += 1;
      if (calls === 1) throw new ApiError({ kind: "http", status: 503, message: "x" });
      return tripData();
    };
    const { user } = setup(async () => aiPlan(), loader);
    const error = await screen.findByTestId("options-error");
    expect(error.textContent).toContain("Interests and places could not load.");
    expect(screen.getByTestId("plan-button").textContent).toBe("Plan my trip");
    await user.click(within(error).getByTestId("options-retry"));
    expect(await screen.findByTestId("data-notes")).toBeTruthy();
    expect(screen.queryByTestId("options-error")).toBeNull();
  });

  it("opens a shared link, notes it, and removes it from the address bar", async () => {
    const plan = fixturePlan();
    window.history.replaceState(null, "", `/?p=${encodeShare(plan)}`);
    setup(async () => aiPlan());
    const rows = await screen.findAllByTestId("stop-row");
    expect(rows.map((row) => row.dataset.placeId)).toEqual(
      plan.days[0]?.stops.map((stop) => stop.placeId),
    );
    expect(screen.getByTestId("share-notice").textContent).toContain("Opened a shared plan.");
    expect(screen.getByTestId("source-badge").textContent).toContain("Shared plan");
    expect(window.location.search).toBe("");
  });

  it("tells the traveler when a shared link is damaged and keeps the form usable", async () => {
    window.history.replaceState(null, "", "/?p=%%%not-a-plan");
    setup(async () => aiPlan());
    expect((await screen.findByTestId("share-notice")).textContent).toContain("damaged");
    expect(screen.getByTestId("trip-form")).toBeTruthy();
    expect(screen.queryAllByTestId("stop-row")).toHaveLength(0);
  });

  it("removes a stop, offers undo, and undo restores the exact plan", async () => {
    const { user } = setup(async () => aiPlan());
    await planOnce(user);
    const before = screen.getAllByTestId("stop-row").map((row) => row.dataset.placeId);
    await user.click(
      within(screen.getAllByTestId("stop-row")[0] as HTMLElement).getByTestId("remove-button"),
    );
    expect(screen.getAllByTestId("stop-row").map((row) => row.dataset.placeId)).toEqual(
      before.slice(1),
    );
    expect(screen.getByTestId("undo-button").textContent).toBe("Undo remove");
    expect(screen.getByTestId("toast").textContent).toContain("Removed");
    await user.click(screen.getByTestId("undo-button"));
    expect(screen.getAllByTestId("stop-row").map((row) => row.dataset.placeId)).toEqual(before);
    expect(screen.queryByTestId("undo-button")).toBeNull();
  });

  it("swaps a stop from the sheet and returns focus to that row's swap button", async () => {
    const { user } = setup(async () => aiPlan());
    await planOnce(user);
    const row = screen.getAllByTestId("stop-row")[1] as HTMLElement;
    const oldId = row.dataset.placeId;
    await user.click(within(row).getByTestId("swap-button"));
    const sheet = await screen.findByTestId("alternatives-sheet");
    const option = within(sheet).getAllByTestId("alternative-option")[0] as HTMLElement;
    await user.click(option);
    await waitFor(() => expect(screen.queryByTestId("alternatives-sheet")).toBeNull());
    const swapped = screen.getAllByTestId("stop-row")[1] as HTMLElement;
    expect(swapped.dataset.placeId).not.toBe(oldId);
    expect(document.activeElement).toBe(within(swapped).getByTestId("swap-button"));
    expect(screen.getByTestId("undo-button").textContent).toBe("Undo swap");
  });

  it("renders an AI summary carrying markup as inert text", async () => {
    const { user } = setup(async () => ({ ...aiPlan(), summary: XSS }));
    await planOnce(user);
    expect(screen.getByTestId("plan-summary").textContent).toBe(XSS);
    // The only images are our own place photos; the summary's markup never becomes an element.
    for (const image of document.querySelectorAll("img")) {
      expect(image.classList.contains("place-photo-img"), image.outerHTML).toBe(true);
      expect(image.hasAttribute("onerror")).toBe(false);
    }
  });

  it("sends ?mode=deterministic through to the API call", async () => {
    window.history.replaceState(null, "", "/?mode=deterministic");
    const post = vi.fn<
      (request: TripRequest, options?: { deterministic?: boolean }) => Promise<Itinerary>
    >(async () => fixturePlan());
    const { user } = setup(post);
    await planOnce(user);
    expect(post.mock.calls[0]?.[1]).toMatchObject({ deterministic: true });
  });
});
