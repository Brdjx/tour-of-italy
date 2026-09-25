import type { Itinerary, TripRequest } from "@italy/planner";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlannerApp } from "../components/PlannerApp";
import { ApiError } from "../lib/apiError";
import { readShareParam } from "../lib/shareLink";
import { aiPlan, tripData } from "./fixtures";

// While a plan is on its way (the first plan, or a new one asked for from the Edit trip sheet),
// the trip header's Edit trip and Copy link are dimmed and do nothing, and they come back when
// the plan arrives or the request fails. They stay focusable, with their names, so nobody loses
// their place; Copy link never hands out the plan before while the next one is on its way.

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

function setup(post: Post) {
  const user = userEvent.setup();
  render(<PlannerApp loader={async () => tripData()} post={post} today={TODAY} />);
  return user;
}

/** A clipboard that records what it was given, or refuses. */
function stubClipboard(refuse = false) {
  const writeText = vi.fn(async (_text: string) => {
    if (refuse) throw new Error("denied");
  });
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  return writeText;
}

const edit = () => screen.getByTestId("edit-trip-button");
const copy = () => screen.getByTestId("share-button");
const tripSheet = () => screen.getByTestId("trip-sheet") as HTMLDialogElement;
const waiting = (button: HTMLElement) => button.getAttribute("aria-disabled") === "true";

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the trip header while a plan is on its way", () => {
  it("dims Edit trip and Copy link for the first plan, and brings them back when it arrives", async () => {
    const next = deferred<Itinerary>();
    const user = setup(() => next.promise);
    const writeText = stubClipboard();
    await user.click(await screen.findByTestId("plan-button"));
    expect(waiting(edit())).toBe(true);
    expect(waiting(copy())).toBe(true);
    // Dimmed, not removed: both keep their names and their place in the tab order.
    expect(edit().hasAttribute("disabled")).toBe(false);
    expect(screen.getByRole("button", { name: "Edit trip" })).toBe(edit());
    expect(screen.getByRole("button", { name: "Copy link" })).toBe(copy());
    await user.click(edit());
    expect(tripSheet().open).toBe(false);
    expect(edit().getAttribute("aria-expanded")).toBe("false");
    await user.click(copy());
    expect(writeText).not.toHaveBeenCalled();

    await act(async () => next.resolve(aiPlan()));
    await screen.findAllByTestId("stop-row");
    expect(edit().hasAttribute("aria-disabled")).toBe(false);
    expect(copy().hasAttribute("aria-disabled")).toBe(false);
    await user.click(copy());
    expect(writeText).toHaveBeenCalledTimes(1);
    await user.click(edit());
    expect(tripSheet().open).toBe(true);
  });

  it("dims them for a plan asked for from the Edit trip sheet, and brings them back when it fails", async () => {
    const next = deferred<Itinerary>();
    const post = vi.fn<Post>().mockResolvedValueOnce(aiPlan()).mockReturnValueOnce(next.promise);
    const user = setup(post);
    const writeText = stubClipboard();
    await user.click(await screen.findByTestId("plan-button"));
    await screen.findAllByTestId("stop-row");
    await user.click(edit());
    await user.click(screen.getByTestId("plan-button"));
    expect(tripSheet().open).toBe(false);
    expect(waiting(edit())).toBe(true);
    expect(waiting(copy())).toBe(true);
    await user.click(copy());
    expect(writeText).not.toHaveBeenCalled();

    const refused = new ApiError({ kind: "http", status: 400, message: "x", details: [] });
    await act(async () => next.reject(refused));
    expect(await screen.findByTestId("error-state")).toBeTruthy();
    expect(edit().hasAttribute("aria-disabled")).toBe(false);
    expect(copy().hasAttribute("aria-disabled")).toBe(false);
    // The plan that came back is the one Copy link shares.
    await user.click(copy());
    const link = new URL(writeText.mock.calls[0]?.[0] as string);
    expect(readShareParam(link.search)).toBeTruthy();
  });

  it("drops a link shown to copy by hand once the next plan is on its way", async () => {
    const next = deferred<Itinerary>();
    const post = vi.fn<Post>().mockResolvedValueOnce(aiPlan()).mockReturnValueOnce(next.promise);
    const user = setup(post);
    stubClipboard(true);
    await user.click(await screen.findByTestId("plan-button"));
    await screen.findAllByTestId("stop-row");
    await user.click(copy());
    expect(screen.getByTestId("share-link-field")).toBeTruthy();
    await user.click(edit());
    await user.click(screen.getByTestId("plan-button"));
    expect(screen.queryByTestId("share-link-field")).toBeNull();
    await act(async () => next.resolve(aiPlan({ pace: "relaxed" })));
    await screen.findAllByTestId("stop-row");
    expect(screen.queryByTestId("share-link-field")).toBeNull();
  });
});
