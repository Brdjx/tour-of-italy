import type { Itinerary, TripRequest } from "@italy/planner";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlannerApp } from "../components/PlannerApp";
import { ApiError } from "../lib/apiError";
import { initialItineraryState, itineraryReducer } from "../lib/itineraryReducer";
import { aiPlan, ctx, must, tripData } from "./fixtures";

// Keyboard focus and the phone flows around the plan: focus is never dropped to the page or
// left off screen after an edit, the Edit trip sheet has a way back, notes show where the
// traveler looks, and the badge says what really happened.

vi.mock("../components/DayMap", () => ({
  DayMap: () => <div data-testid="day-map" />,
  prefetchMap: () => () => {},
}));

type Post = (request: TripRequest) => Promise<Itinerary>;
const scrolled: Element[] = [];

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  window.localStorage.clear();
  scrolled.length = 0;
  // jsdom has no layout; record what the page asks to bring into view.
  Element.prototype.scrollIntoView = function scrollIntoView(this: Element) {
    scrolled.push(this);
  };
});

afterEach(cleanup);

async function planned(post: Post = async () => aiPlan()) {
  const user = userEvent.setup();
  render(
    <PlannerApp loader={async () => tripData()} post={post} today={() => new Date(2026, 8, 23)} />,
  );
  await user.click(await screen.findByTestId("plan-button"));
  await screen.findAllByTestId("stop-row");
  return user;
}

/** The first "move down" in the plan that the validator flags, found with the real reducer. */
function firstBreakingMove(plan: Itinerary): { day: number; stop: number } | null {
  const state = itineraryReducer(
    initialItineraryState(),
    { type: "plan", itinerary: plan, origin: "api" },
    ctx,
  );
  for (const [day, dayPlan] of plan.days.entries()) {
    for (let stop = 0; stop < dayPlan.stops.length - 1; stop++) {
      const next = itineraryReducer(state, { type: "move", day, stop, direction: "down" }, ctx);
      if (next.errors.length > 0) return { day, stop };
    }
  }
  return null;
}

const rows = () => screen.getAllByTestId("stop-row");
const row = (index: number) => rows()[index] as HTMLElement;
const idsNow = () => rows().map((item) => item.dataset.placeId);

describe("focus after edits", () => {
  it("moves focus to the Swap button of the row that took a removed stop's place", async () => {
    const user = await planned();
    const before = idsNow();
    await user.click(within(row(0)).getByTestId("remove-button"));
    expect(idsNow()).toEqual(before.slice(1));
    expect(document.activeElement).toBe(within(row(0)).getByTestId("swap-button"));
    expect(scrolled).toContain(document.activeElement);
  });

  it("moves focus to the new last row when the last stop is removed", async () => {
    const user = await planned();
    const last = rows().length - 1;
    await user.click(within(row(last)).getByTestId("remove-button"));
    expect(document.activeElement).toBe(within(row(last - 1)).getByTestId("swap-button"));
  });

  it("keeps focus on the moved stop's button and brings it into view", async () => {
    const user = await planned();
    const moving = row(0).dataset.placeId;
    const button = within(row(0)).getByTestId("move-down");
    await user.click(button);
    expect(row(1).dataset.placeId).toBe(moving);
    expect(document.activeElement).toBe(within(row(1)).getByTestId("move-down"));
    expect(scrolled).toContain(document.activeElement);
  });

  it("puts focus on the row that came back when the toast's Undo disappears", async () => {
    const user = await planned();
    const removed = row(1).dataset.placeId;
    await user.click(within(row(1)).getByTestId("remove-button"));
    await user.click(screen.getByTestId("toast-undo"));
    expect(row(1).dataset.placeId).toBe(removed);
    expect(document.activeElement).toBe(within(row(1)).getByTestId("swap-button"));
    expect(document.activeElement).not.toBe(document.body);
  });

  it("puts focus on the restored row when the toolbar Undo goes away with the last edit", async () => {
    const user = await planned();
    const moved = row(2).dataset.placeId;
    await user.click(within(row(2)).getByTestId("move-up"));
    await user.click(screen.getByTestId("undo-button"));
    expect(screen.queryByTestId("undo-button")).toBeNull();
    expect(row(2).dataset.placeId).toBe(moved);
    expect(document.activeElement).toBe(within(row(2)).getByTestId("swap-button"));
  });

  it("announces the same message again when the same edit is made twice", async () => {
    const user = await planned();
    const region = screen.getByTestId("live-region");
    await user.click(within(row(0)).getByTestId("move-down"));
    const first = region.firstElementChild;
    await user.click(within(row(1)).getByTestId("move-up"));
    await user.click(within(row(0)).getByTestId("move-down"));
    expect(region.textContent).toBe(first?.textContent);
    // A new node each time: screen readers announce insertions, not unchanged text.
    expect(region.firstElementChild).not.toBe(first);
  });
});

describe("the form reopened over a plan", () => {
  it("moves focus to the form heading and offers a way back that returns focus", async () => {
    const user = await planned();
    await user.click(screen.getByTestId("edit-trip-button"));
    const heading = screen.getByTestId("form-heading");
    expect(document.activeElement).toBe(heading);
    expect(screen.getByTestId("form-return").textContent).toContain(
      "Your current plan stays until you plan again.",
    );
    await user.click(screen.getByTestId("back-to-plan"));
    expect((screen.getByTestId("trip-sheet") as HTMLDialogElement).open).toBe(false);
    expect(document.activeElement).toBe(screen.getByTestId("edit-trip-button"));
    expect(rows().length).toBeGreaterThan(0);
  });

  it("shows progress next to the plan button when the form is opened while planning", async () => {
    let finish: (plan: Itinerary) => void = () => {};
    const user = userEvent.setup();
    render(
      <PlannerApp
        loader={async () => tripData()}
        post={() => new Promise<Itinerary>((resolve) => (finish = resolve))}
      />,
    );
    await user.click(await screen.findByTestId("plan-button"));
    await user.click(screen.getByTestId("edit-trip-button"));
    const progress = screen.getByTestId("form-planning");
    expect(progress.closest("[hidden]")).toBeNull();
    expect(progress.textContent).toContain("Choosing places");
    finish(aiPlan());
    await waitFor(() => expect(screen.queryByTestId("form-planning")).toBeNull());
  });
});

describe("notes and labels", () => {
  it("puts a damaged link's note above the form, where a phone shows it first", async () => {
    window.history.replaceState(null, "", "/?p=bm90LWpzb24");
    render(<PlannerApp loader={async () => tripData()} post={async () => aiPlan()} />);
    const note = await screen.findByTestId("share-notice");
    const pane = document.getElementById("trip-form-pane") as HTMLElement;
    expect(pane.contains(note)).toBe(true);
    const form = screen.getByTestId("trip-form");
    expect(note.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(note.textContent).not.toMatch(/below|above/);
  });

  it("labels a plan built after a 503 as made on this device, never offline", async () => {
    await planned(async () => {
      throw new ApiError({ kind: "http", status: 503, message: "x" });
    });
    expect(screen.queryByTestId("offline-label")).toBeNull();
    expect(screen.getByTestId("source-badge").textContent).toContain(
      "Planned without AI, on this device",
    );
  });

  it("stops saying 'checked' once an edit breaks a rule, and says so again after undo", async () => {
    const target = must(firstBreakingMove(aiPlan()), "a move that breaks a rule in the fixture");
    const user = await planned();
    const badge = () => screen.getByTestId("source-badge").textContent ?? "";
    expect(badge()).toContain("Planned with AI, checked against hours and distance");
    await user.click(screen.getByTestId(`day-tab-${target.day + 1}`));
    await user.click(within(row(target.stop)).getByTestId("move-down"));
    expect(document.querySelector('[data-flagged="true"]')).not.toBeNull();
    expect(badge()).toMatch(/^Edited by you, \d+ problems? to fix/);
    expect(badge()).not.toContain("checked against");
    await user.click(screen.getByTestId("undo-button"));
    expect(badge()).toContain("Planned with AI, checked against hours and distance");
  });
});
