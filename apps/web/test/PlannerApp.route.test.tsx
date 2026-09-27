import type { Itinerary, TripRequest } from "@italy/planner";
import {
  act,
  cleanup,
  configure,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlannerApp } from "../components/PlannerApp";
import type { SaveTrip } from "../components/ShareButton";
import type { PlanCallOptions, PlanDayBody, SaveTripBody } from "../lib/api";
import { ApiError } from "../lib/apiError";
import type { PlanDayResponse } from "../lib/apiSchemas";
import { replannedNote } from "../lib/copyLink";
import { LAST_PLAN_KEY } from "../lib/lastPlan";
import { SLOW_PLAN_MS } from "../lib/usePlanTrip";
import { AI_DAY_REASON, aiPlan, dayAnswerFor, must, tripData } from "./fixtures";

// The route sheet on the real page (decision 16): the city on a day's line opens that day's
// cities over the route; choosing one sets it and shows what the route does; its action plans the
// days it names one request at a time, in day order, each with the route and the days planned
// before it, while those days show their skeletons and the rest of the trip stays readable with
// editing waiting; the days go in as one edit with Undo; and when the API cannot answer, the days
// are planned here and labelled as rules plans. What would break the product: a city refused for
// its travel, a place on two days, a day shown as the AI's that the rules planned, an Undo that
// does not restore the trip exactly, focus lost between the levels, or a saved trip that differs.

vi.mock("../components/DayMap", () => ({
  DayMap: ({ busy }: { busy?: boolean }) => (
    <div data-testid="day-map" data-busy={busy ? "true" : undefined} />
  ),
  prefetchMap: () => () => {},
}));

configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 30_000 });

type PostDay = (body: PlanDayBody, options: PlanCallOptions) => Promise<PlanDayResponse>;
type User = ReturnType<typeof userEvent.setup>;

/** Three days in Rome, planned with AI. */
const PLAN = { ...aiPlan(), planId: "Zz9Yy8Xx7W" };

interface Setup {
  postDay: PostDay;
  post?: (request: TripRequest) => Promise<Itinerary>;
  saveTrip?: SaveTrip;
}

function setup({ postDay, post = async () => PLAN, saveTrip }: Setup) {
  const user = userEvent.setup();
  render(
    <PlannerApp
      loader={async () => tripData()}
      post={post}
      postDay={postDay}
      today={() => new Date(2026, 8, 23)}
      {...(saveTrip ? { saveTrip } : {})}
    />,
  );
  return { user };
}

/** POST /api/plan/day answering at once, like the API, from the trip the body carries. */
const answering = vi.fn<PostDay>(async (body) => dayAnswerFor(body));

/** A POST /api/plan/day that answers each request when the test says. */
function deferredDays() {
  const waiting: (() => void)[] = [];
  const post = vi.fn<PostDay>(
    (body) =>
      new Promise<PlanDayResponse>((resolve) => {
        waiting.push(() => resolve(dayAnswerFor(body)));
      }),
  );
  return { post, answer: () => act(async () => waiting.shift()?.()) };
}

async function planAndOpen(user: User, day: number) {
  await user.click(await screen.findByTestId("plan-button"));
  await screen.findAllByTestId("stop-row");
  await user.click(screen.getByTestId(`day-tab-${day}`));
  return stopIds();
}

function stopIds(): string[] {
  return screen.queryAllByTestId("stop-row").map((row) => row.dataset.placeId ?? "");
}

async function tripIds(user: User): Promise<string[][]> {
  const days: string[][] = [];
  for (const day of [1, 2, 3]) {
    await user.click(screen.getByTestId(`day-tab-${day}`));
    days.push(stopIds());
  }
  return days;
}

function sheet(): HTMLElement {
  return screen.getByTestId("route-sheet");
}

function option(anchorId: string): HTMLElement {
  return must(
    within(sheet())
      .getAllByTestId("city-option")
      .find((element) => element.dataset.anchorId === anchorId),
    `the ${anchorId} option`,
  );
}

function routeDay(day: number): HTMLElement {
  return must(
    within(sheet())
      .getAllByTestId("route-day")
      .find((element) => element.dataset.day === String(day - 1)),
    `day ${day} of the route`,
  );
}

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  window.localStorage.clear();
  answering.mockClear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("the route sheet", () => {
  it("opens on the tapped day's cities over the route, every city allowed, with Back and Escape", async () => {
    const { user } = setup({ postDay: answering });
    await planAndOpen(user, 2);
    const pill = screen.getByRole("button", { name: "Rome, change city" });
    expect(pill.getAttribute("aria-expanded")).toBe("false");
    await user.click(pill);

    expect(sheet().hasAttribute("open")).toBe(true);
    expect(pill.getAttribute("aria-expanded")).toBe("true");
    const title = within(sheet()).getByRole("heading", { name: "City for day 2" });
    expect(document.activeElement).toBe(title);
    expect(within(sheet()).getByText("Wednesday 7 October")).toBeTruthy();
    const options = within(sheet()).getAllByTestId("city-option");
    expect(options.map((element) => element.dataset.anchorId)).toEqual([
      "florence",
      "milan",
      "venice",
      "bologna",
    ]);
    // Travel is the traveler's choice (decision 16): every city can take day 2, with its facts.
    for (const element of options) {
      expect(element.getAttribute("aria-disabled")).toBeNull();
      expect(element.querySelector(".city-option-chevron")).not.toBeNull();
    }
    expect(option("milan").textContent).toContain("3 h 35 min by high-speed train from Rome");
    expect(option("milan").textContent).toContain("Day 3 will be planned again");

    // Back: the route, with focus on the day the list was for.
    await user.click(within(sheet()).getByTestId("route-back"));
    expect(within(sheet()).getByRole("heading", { name: "Your route" })).toBeTruthy();
    expect(document.activeElement).toBe(routeDay(2));
    // Escape on a day's cities goes back; on the route it closes, and focus returns to the pill.
    await user.click(routeDay(3));
    expect(document.activeElement).toBe(
      within(sheet()).getByRole("heading", { name: "City for day 3" }),
    );
    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
    expect(document.activeElement).toBe(routeDay(3));
    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
    expect(sheet().hasAttribute("open")).toBe(false);
    expect(document.activeElement).toBe(pill);
    expect(answering).not.toHaveBeenCalled();
  });

  it("moves one day, plans it and the next day in turn, and goes in as one edit that Undo takes back", async () => {
    const days = deferredDays();
    const { user } = setup({ postDay: days.post });
    await planAndOpen(user, 2);
    const before = await tripIds(user);
    await user.click(screen.getByTestId("day-tab-2"));
    await user.click(screen.getByTestId("city-button"));
    await user.click(option("florence"));

    // Back on the route: the change marked, when the day now starts, flipped in, what the
    // travel leaves of it, what it does to day 3, and one action named by it.
    const second = routeDay(2);
    expect(second.dataset.changed).toBe("true");
    expect(second.textContent).toContain("was Rome");
    const start = within(second).getByTestId("route-day-start");
    expect(start.textContent).toBe("Starts at 11:40");
    expect(start.querySelector('[data-flip="true"]')?.textContent).toBe("11:40");
    expect(second.querySelector('.city-name[data-flip="true"]')?.textContent).toBe("Florence");
    expect(second.textContent).toContain("Leaves about 7 h before dinner.");
    expect(second.textContent).not.toContain("will be planned in Florence");
    expect(routeDay(3).textContent).toContain(
      "Day 3 will be planned again: it now starts after 2 h 10 min of travel.",
    );
    // Day 1 is as it was: nothing on it flips.
    expect(routeDay(1).querySelector("[data-flip]")).toBeNull();
    expect(document.activeElement).toBe(second);
    expect(within(sheet()).getByTestId("route-said").textContent).toBe("Day 2 set to Florence.");
    await user.click(within(sheet()).getByRole("button", { name: "Plan day 2 and day 3" }));

    // One request for day 2: the route, and day 3 still to plan.
    expect(days.post).toHaveBeenCalledTimes(1);
    const [first, options] = must(days.post.mock.calls[0]);
    expect(first).toEqual({
      request: PLAN.request,
      days: [
        { anchorId: "rome", ids: before[0] },
        { anchorId: "florence", ids: [] },
        { anchorId: "rome", ids: [] },
      ],
      day: 1,
      anchorId: "florence",
      route: ["rome", "florence", "rome"],
    });
    expect(options.signal).toBeInstanceOf(AbortSignal);

    // While it works: day 2 says so with its skeleton, day 3 waits, and focus is on day 2's heading.
    expect(sheet().hasAttribute("open")).toBe(false);
    expect(screen.getByTestId("day-planning").textContent).toBe(
      "Planning day 2 in Florence (1 of 2)",
    );
    expect(screen.getByTestId("day-skeleton-rows")).toBeTruthy();
    expect(screen.getByTestId("day-map").dataset.busy).toBe("true");
    expect(document.activeElement).toBe(document.getElementById("day-heading-1"));
    expect(screen.getByTestId("day-tab-2").dataset.busy).toBe("planning");
    expect(screen.getByTestId("day-tab-3").dataset.busy).toBe("waiting");
    expect(screen.getByTestId("live-region").textContent).toBe(
      "Planning day 2 in Florence (1 of 2).",
    );
    // The rest of the trip is readable; editing waits, and says so.
    await user.click(screen.getByTestId("day-tab-1"));
    expect(stopIds()).toEqual(before[0]);
    expect(screen.getByTestId("day-locked").textContent).toBe(
      "Editing waits until day 2 and day 3 are planned.",
    );
    const swap = must(screen.getAllByTestId("swap-button")[0]);
    expect(swap.getAttribute("aria-disabled")).toBe("true");
    await user.click(swap);
    expect(screen.queryByTestId("alternatives-sheet")).toBeNull();
    expect(screen.getByTestId("city-button").getAttribute("aria-disabled")).toBe("true");
    expect(screen.queryByTestId("undo-button")).toBeNull();
    await user.click(screen.getByTestId("day-tab-3"));
    expect(screen.getByTestId("day-planning").textContent).toBe(
      "Waiting to plan day 3 in Rome (2 of 2)",
    );

    await days.answer();
    // Day 2 is in and shows at once; day 3 is asked for with it.
    expect(days.post).toHaveBeenCalledTimes(2);
    const next = must(days.post.mock.calls[1])[0];
    await user.click(screen.getByTestId("day-tab-2"));
    const secondIds = stopIds();
    expect(secondIds.length).toBeGreaterThan(0);
    expect(next.days[1]).toEqual({ anchorId: "florence", ids: secondIds });
    expect(next).toMatchObject({ day: 2, anchorId: "rome", route: ["rome", "florence", "rome"] });
    expect(screen.getByTestId("day-source").textContent).toBe("Planned again with AI");
    expect(screen.getByTestId("day-locked").textContent).toBe(
      "Editing waits until day 3 is planned.",
    );
    // Its travel, as facts on the day itself.
    expect(screen.getByTestId("transfer-note").textContent).toContain(
      "2 h 10 min by high-speed train from Rome",
    );
    expect(screen.getByTestId("transfer-left").textContent).toBe("Leaves about 7 h before dinner.");

    await days.answer();
    const toast = screen.getByTestId("toast");
    expect(toast.textContent).toContain("Day 2 now in Florence. Day 3 planned again.");
    expect(within(toast).getByTestId("toast-undo").textContent).toBe("Undo city change");
    expect(screen.getByTestId("source-badge").textContent).toContain("Planned with AI, edited");
    const after = await tripIds(user);
    expect(after[0]).toEqual(before[0]);
    expect(after[1]?.some((id) => before[1]?.includes(id))).toBe(false);
    expect(new Set(after.flat()).size).toBe(after.flat().length);
    expect(screen.getByTestId("day-subtitle").textContent).toContain("Day 3 in Rome");
    expect(screen.getByTestId("day-source").textContent).toBe("Planned again with AI");
    const reasons = screen.getAllByTestId("stop-reason");
    expect(reasons.some((reason) => reason.textContent?.includes(AI_DAY_REASON))).toBe(true);
    expect(document.querySelector('[data-flagged="true"]')).toBeNull();

    // One Undo brings every day back exactly.
    await user.click(screen.getByTestId("undo-button"));
    expect(await tripIds(user)).toEqual(before);
    expect(screen.queryByTestId("day-source")).toBeNull();
    expect(screen.queryByTestId("undo-button")).toBeNull();
    expect(screen.getByTestId("source-badge").textContent).not.toContain("edited");
  });

  it("sets three new cities, one a day, and plans them with no place anywhere twice", async () => {
    const { user } = setup({ postDay: answering });
    await planAndOpen(user, 1);
    const before = await tripIds(user);
    await user.click(screen.getByTestId("day-tab-1"));
    await user.click(screen.getByTestId("city-button"));
    await user.click(option("florence"));
    await user.click(routeDay(2));
    await user.click(option("venice"));
    await user.click(routeDay(3));
    await user.click(option("milan"));
    expect(within(sheet()).getByTestId("route-travel").textContent).toMatch(
      /^Travel between cities: \d+ h/,
    );
    await user.click(within(sheet()).getByRole("button", { name: "Plan all three days" }));
    await waitFor(() => expect(screen.getByTestId("toast").textContent).toContain("Route changed"));

    expect(answering).toHaveBeenCalledTimes(3);
    expect(answering.mock.calls.map(([body]) => body.day)).toEqual([0, 1, 2]);
    expect(screen.getByTestId("live-region").textContent).toBe(
      "Route changed: Florence, Venice, Milan.",
    );
    expect(within(screen.getByTestId("toast")).getByTestId("toast-undo").textContent).toBe(
      "Undo route change",
    );
    const after = await tripIds(user);
    const all = after.flat();
    expect(new Set(all).size).toBe(all.length);
    expect(all.some((id) => before.flat().includes(id))).toBe(false);
    for (const [index, city] of ["Florence", "Venice", "Milan"].entries()) {
      await user.click(screen.getByTestId(`day-tab-${index + 1}`));
      expect(screen.getByTestId("day-subtitle").textContent).toContain(
        `Day ${index + 1} in ${city}`,
      );
      expect(screen.getByTestId("day-source").textContent).toBe("Planned again with AI");
    }
    expect(document.querySelector('[data-flagged="true"]')).toBeNull();
    await user.click(screen.getByTestId("undo-button"));
    expect(await tripIds(user)).toEqual(before);
  });

  it("resets the route, or leaves the trip as it was when closed", async () => {
    const { user } = setup({ postDay: answering });
    const before = await planAndOpen(user, 3);
    await user.click(screen.getByTestId("city-button"));
    await user.click(option("venice"));
    await user.click(within(sheet()).getByTestId("route-reset"));
    // The foot stays, dimmed until there is a change again.
    const action = within(sheet()).getByTestId("route-confirm");
    expect(action.textContent).toBe("No changes to plan");
    expect(action.getAttribute("aria-disabled")).toBe("true");
    expect(routeDay(3).dataset.changed).toBeUndefined();
    // Day 3's city flips back to the trip's.
    expect(routeDay(3).querySelector('.city-name[data-flip="true"]')?.textContent).toBe("Rome");
    expect(within(sheet()).getByTestId("route-said").textContent).toBe("Route reset.");
    await user.click(routeDay(3));
    await user.click(option("venice"));
    await user.click(within(sheet()).getByTestId("route-close"));
    expect(sheet().hasAttribute("open")).toBe(false);
    expect(answering).not.toHaveBeenCalled();
    expect(stopIds()).toEqual(before);
    // Opened again, the route starts from the trip.
    await user.click(screen.getByTestId("city-button"));
    await user.click(within(sheet()).getByTestId("route-back"));
    expect(routeDay(3).dataset.changed).toBeUndefined();
  });

  it("shows a city the day cannot take with its reason and the way out, and a press does nothing", async () => {
    // The Uffizi was asked for; day 1 is the trip's only Florence day.
    const pinned = { ...aiPlan({ mustInclude: ["place_026"] }), planId: "Pp9Yy8Xx7W" };
    const { user } = setup({ postDay: answering, post: async () => pinned });
    await planAndOpen(user, 1);
    await user.click(screen.getByTestId("city-button"));
    const rome = option("rome");
    expect(rome.getAttribute("aria-disabled")).toBe("true");
    expect(rome.querySelector(".city-option-chevron")).toBeNull();
    expect(rome.textContent).toContain(
      "Day 1 has Uffizi Gallery, which you asked for, and no other day of this route is in Florence. Keep day 1 in Florence, or remove Uffizi Gallery from day 1 first.",
    );
    expect(option("milan").textContent).toContain("This day has a place you asked for.");
    await user.click(rome);
    expect(within(sheet()).getByRole("heading", { name: "City for day 1" })).toBeTruthy();
    expect(within(sheet()).queryByTestId("route-view")).toBeNull();
  });

  it("gives new ideas for a day in its own city, leaving out the places it has", async () => {
    const { user } = setup({ postDay: answering });
    const before = await planAndOpen(user, 2);
    await user.click(screen.getByTestId("city-button"));
    await user.click(within(sheet()).getByRole("button", { name: "New ideas for this day" }));

    const body = must(answering.mock.calls[0])[0];
    expect(body).toMatchObject({ day: 1, anchorId: "rome", avoid: before });
    expect(body).not.toHaveProperty("route");
    await waitFor(() => expect(screen.getByTestId("day-source")).toBeTruthy());
    const after = stopIds();
    expect(after.some((id) => before.includes(id))).toBe(false);
    expect(screen.getByTestId("day-subtitle").textContent).toContain("Day 2 in Rome");
    expect(screen.getByTestId("live-region").textContent).toBe("New ideas for day 2.");
    // Focus stayed on the day's heading, where the sheet left it, so reading starts there.
    expect(document.activeElement).toBe(document.getElementById("day-heading-1"));
    expect(screen.getByTestId("undo-button").textContent).toContain("Undo new ideas");
    expect(screen.getByTestId("plan-summary").textContent).toBe("Three days of food in Rome.");
  });

  it("plans the days on this device when the API cannot answer, asking once, and labels them", async () => {
    const postDay = vi.fn<PostDay>(async () => {
      throw new ApiError({ kind: "network", message: "offline" });
    });
    const { user } = setup({ postDay });
    const before = await planAndOpen(user, 2);
    await user.click(screen.getByTestId("city-button"));
    await user.click(option("venice"));
    await user.click(within(sheet()).getByRole("button", { name: "Plan day 2 and day 3" }));

    await waitFor(() => expect(screen.getByTestId("day-source")).toBeTruthy());
    expect(postDay).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("day-source").textContent).toBe(
      "Planned again on this device, offline",
    );
    expect(screen.getByTestId("day-source").dataset.marker).toBe("rules");
    expect(screen.getByTestId("day-subtitle").textContent).toContain("Day 2 in Venice");
    expect(stopIds().some((id) => before.includes(id))).toBe(false);
    for (const reason of screen.getAllByTestId("stop-reason")) {
      expect(reason.textContent).toContain("Why, from the rules:");
    }
    expect(screen.getByTestId("live-region").textContent).toBe(
      "Day 2 now in Venice. Day 3 planned again. Planned without AI on this device.",
    );
    await user.click(screen.getByTestId("day-tab-3"));
    expect(screen.getByTestId("day-source").textContent).toBe(
      "Planned again on this device, offline",
    );
    expect(document.querySelector('[data-flagged="true"]')).toBeNull();
  });

  it("names the day whose call failed on a day of the run that was not sent", async () => {
    const postDay = vi.fn<PostDay>(async () => {
      throw new ApiError({ kind: "http", status: 503, message: "x" });
    });
    const { user } = setup({ postDay });
    await planAndOpen(user, 2);
    await user.click(screen.getByTestId("city-button"));
    await user.click(option("venice"));
    await user.click(within(sheet()).getByRole("button", { name: "Plan day 2 and day 3" }));

    await waitFor(() => expect(screen.getByTestId("day-source")).toBeTruthy());
    expect(postDay).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("day-source").textContent).toBe(
      "Planned again on this device: the server failed",
    );
    await user.click(screen.getByTestId("day-tab-3"));
    expect(screen.getByTestId("day-source").textContent).toBe(
      "Planned again on this device: the server failed on day 2",
    );
  });

  it("says after a while that the day is still being planned", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const days = deferredDays();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(
      <PlannerApp
        loader={async () => tripData()}
        post={async () => PLAN}
        postDay={days.post}
        today={() => new Date(2026, 8, 23)}
      />,
    );
    await planAndOpen(user, 3);
    await user.click(screen.getByTestId("city-button"));
    await user.click(option("florence"));
    await user.click(within(sheet()).getByRole("button", { name: "Plan day 3" }));
    expect(screen.queryByTestId("day-planning-slow")).toBeNull();
    await act(async () => vi.advanceTimersByTime(SLOW_PLAN_MS));
    expect(screen.getByTestId("day-planning-slow").textContent).toBe(
      "Still working. If the AI planner takes too long, the day is planned with rules.",
    );
    await days.answer();
    expect(screen.queryByTestId("day-planning-slow")).toBeNull();
    expect(screen.queryByTestId("day-planning")).toBeNull();
  });

  it("gives up a route still on its way when a new plan arrives", async () => {
    const days = deferredDays();
    const post = vi.fn(async () => PLAN);
    const { user } = setup({ postDay: days.post, post });
    const before = await planAndOpen(user, 3);
    await user.click(screen.getByTestId("city-button"));
    await user.click(option("florence"));
    await user.click(within(sheet()).getByRole("button", { name: "Plan day 3" }));
    expect(screen.getByTestId("day-planning")).toBeTruthy();

    // Another pace: a new plan from the Edit trip sheet.
    await user.click(screen.getByTestId("edit-trip-button"));
    await user.click(screen.getByRole("radio", { name: "Packed" }));
    await user.click(screen.getByTestId("plan-button"));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByTestId("day-planning")).toBeNull());
    const signal = must(days.post.mock.calls[0])[1].signal;
    expect(signal?.aborted).toBe(true);
    await days.answer();
    await user.click(screen.getByTestId("day-tab-3"));
    expect(stopIds()).toEqual(before);
    expect(screen.queryByTestId("day-source")).toBeNull();
  });

  it("saves a trip of three cities with each day's ids, and says which days show the rules' why lines", async () => {
    const saveTrip = vi.fn(async (_body: SaveTripBody) => "a1B2c3D4e5");
    const { user } = setup({ postDay: answering, saveTrip });
    await planAndOpen(user, 1);
    const writeText = vi.fn(async (_text: string) => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    await user.click(screen.getByTestId("city-button"));
    await user.click(option("florence"));
    await user.click(routeDay(3));
    await user.click(option("venice"));
    await user.click(within(sheet()).getByRole("button", { name: "Plan all three days" }));
    await waitFor(() => expect(screen.getByTestId("toast").textContent).toContain("Route changed"));
    const trip = await tripIds(user);

    await user.click(screen.getByTestId("share-button"));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const body = must(saveTrip.mock.calls[0])[0];
    expect(body.planId).toBe("Zz9Yy8Xx7W");
    expect(body.days.map((day) => day.anchorId)).toEqual(["florence", "rome", "venice"]);
    expect(body.days.map((day) => day.ids)).toEqual(trip);
    const note = must(replannedNote([1, 2, 3]));
    await waitFor(() => expect(screen.getByTestId("share-note").textContent).toBe(note));
  });

  it("keeps each day's line after the app is reopened", async () => {
    const { user } = setup({ postDay: answering });
    await planAndOpen(user, 2);
    await user.click(screen.getByTestId("city-button"));
    await user.click(option("florence"));
    await user.click(within(sheet()).getByRole("button", { name: "Plan day 2 and day 3" }));
    await waitFor(() => expect(screen.getByTestId("toast")).toBeTruthy());
    const stored = JSON.parse(window.localStorage.getItem(LAST_PLAN_KEY) ?? "{}");
    expect(stored.days).toEqual([
      null,
      { kind: "api", source: "ai" },
      { kind: "api", source: "ai" },
    ]);

    cleanup();
    render(
      <PlannerApp
        loader={async () => tripData()}
        post={async () => PLAN}
        postDay={answering}
        today={() => new Date(2026, 8, 23)}
      />,
    );
    await screen.findAllByTestId("stop-row");
    await userEvent.setup().click(screen.getByTestId("day-tab-2"));
    expect(screen.getByTestId("day-subtitle").textContent).toContain("Day 2 in Florence");
    expect(screen.getByTestId("day-source").textContent).toBe("Planned again with AI");
    expect(screen.getByTestId("source-badge").textContent).toContain("edited");
  });

  it("says the day was edited once a stop on it changes after it was planned again", async () => {
    const { user } = setup({ postDay: answering });
    await planAndOpen(user, 3);
    await user.click(screen.getByTestId("city-button"));
    await user.click(option("florence"));
    await user.click(within(sheet()).getByRole("button", { name: "Plan day 3" }));
    await waitFor(() =>
      expect(screen.getByTestId("day-source").textContent).toBe("Planned again with AI"),
    );
    const rows = screen.getAllByTestId("stop-row");
    await user.click(within(must(rows[0])).getByTestId("remove-button"));
    await waitFor(() =>
      expect(screen.getByTestId("day-source").textContent).toBe("Planned again with AI, edited"),
    );
    await user.click(screen.getByTestId("undo-button"));
    await waitFor(() =>
      expect(screen.getByTestId("day-source").textContent).toBe("Planned again with AI"),
    );
  });

  it("shows no 'not one of your bases' note on a day the traveler moved to another city", async () => {
    // Rome chosen in the form: Florence is not one of the traveler's bases, but they chose it.
    const rome = { ...aiPlan({ anchors: ["rome"] }), planId: "Rr9Yy8Xx7W" };
    const { user } = setup({ postDay: answering, post: async () => rome });
    await planAndOpen(user, 3);
    await user.click(screen.getByTestId("city-button"));
    await user.click(option("florence"));
    await user.click(within(sheet()).getByRole("button", { name: "Plan day 3" }));
    await waitFor(() => expect(screen.getByTestId("day-source")).toBeTruthy());
    expect(screen.getByTestId("day-subtitle").textContent).toContain("Day 3 in Florence");
    const labels = screen.queryAllByTestId("warning-chip").map((chip) => chip.textContent);
    expect(labels.some((label) => label?.includes("Not one of your bases"))).toBe(false);
    expect(screen.queryByText(/not one of the bases you chose/)).toBeNull();
  });
});

// A missing meal (decision 17), on the owner's route: Rome, Venice, Bologna from Saturday 10
// October, day 3 a Monday, when none of Bologna's dinner places opens. The route warns before
// Bologna is chosen, the day says why it has no dinner and offers another city, and a day where
// code added a meal the AI left out says it was fixed after a check.
describe("a meal a day cannot have", () => {
  const SATURDAY = { ...aiPlan({ startDate: "2026-10-10" }), planId: "Mm9Yy8Xx7W" };

  /** The chip on the day's line with this label. */
  function chip(label: string): HTMLElement {
    return must(
      screen.getAllByTestId("warning-chip").find((one) => one.textContent === label),
      `the ${label} chip`,
    );
  }

  /** Day 2 to Venice and day 3 to Bologna, planned. */
  async function ownersRoute(user: User) {
    await planAndOpen(user, 2);
    await user.click(screen.getByTestId("city-button"));
    await user.click(option("venice"));
    await user.click(routeDay(3));
    await user.click(option("bologna"));
    await user.click(within(sheet()).getByRole("button", { name: "Plan day 2 and day 3" }));
    await waitFor(() =>
      expect(screen.getByTestId("live-region").textContent).toContain(
        "Route changed: Rome, Venice, Bologna.",
      ),
    );
    await user.click(screen.getByTestId("day-tab-3"));
  }

  it("says before Bologna is chosen that it has no dinner on Mondays, and Bologna stays a choice", async () => {
    const { user } = setup({ postDay: answering, post: async () => SATURDAY });
    await planAndOpen(user, 2);
    await user.click(screen.getByTestId("city-button"));
    await user.click(option("venice"));
    await user.click(routeDay(3));
    const bologna = option("bologna");
    expect(bologna.dataset.allowed).toBe("true");
    const facts = [...bologna.querySelectorAll(".city-warning")].map((fact) => fact.textContent);
    expect(facts).toEqual([
      "2 h 25 min by train or car from Venice, so the day starts at 11:55.",
      "No dinner place listed for Bologna opens on Mondays.",
    ]);
    // Said to a screen reader with the city's name.
    const description = document.getElementById(bologna.getAttribute("aria-describedby") ?? "");
    expect(description?.textContent).toContain(
      "No dinner place listed for Bologna opens on Mondays.",
    );
    await user.click(bologna);
    const third = routeDay(3);
    expect(third.textContent).toContain("was");
    expect([...third.querySelectorAll(".city-warning")].map((fact) => fact.textContent)).toEqual([
      "No dinner place listed for Bologna opens on Mondays.",
    ]);
    expect(within(sheet()).getByTestId("route-confirm").getAttribute("aria-disabled")).toBeNull();
  });

  it("says why day 3 has no dinner once planned, and offers another city for it", async () => {
    const { user } = setup({ postDay: answering, post: async () => SATURDAY });
    await ownersRoute(user);
    expect(screen.getByTestId("day-subtitle").textContent).toContain("Day 3 in Bologna");
    // No dinner to have: the transfer does not count the hours before it.
    expect(screen.getByTestId("transfer-note").textContent).toContain("from Venice");
    expect(screen.queryByTestId("transfer-left")).toBeNull();
    const none = chip("No dinner open");
    await user.click(none);
    const panel = must(document.getElementById(none.getAttribute("aria-controls") ?? ""));
    expect(panel.hidden).toBe(false);
    expect(panel.textContent).toContain(
      "The three dinner places listed for Bologna are all closed on Mondays.",
    );
    expect(
      within(panel)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual([
      "Osteria Francescana, Modena",
      "Tagliatelle al Ragù at Trattoria Anna Maria",
      "Enoteca Italiana, Bologna",
    ]);
    expect(panel.textContent).not.toMatch(/swap/i);
    await user.click(within(panel).getByTestId("chip-city"));
    expect(sheet().hasAttribute("open")).toBe(true);
    expect(within(sheet()).getByRole("heading", { name: "City for day 3" })).toBeTruthy();
  });

  it("gives back a dinner taken off through the swap its chip names, and names Undo while it would", async () => {
    // Review (2026-09-26): the chip said to swap a stop near dinner time for a place to eat, but a
    // place to eat could only replace a meal, and it named Undo on a plan with nothing to undo.
    const { user } = setup({ postDay: answering, post: async () => SATURDAY });
    await planAndOpen(user, 1);
    const rows = () => screen.getAllByTestId("stop-row");
    const dinner = must(
      rows().find((row) => row.textContent?.includes("Dinner")),
      "the dinner row",
    );
    await user.click(within(dinner).getByTestId("remove-button"));
    const planned = chip("No dinner planned");
    await user.click(planned);
    const panel = must(document.getElementById(planned.getAttribute("aria-controls") ?? ""));
    expect(panel.textContent).toMatch(
      /Swap a stop near dinner time for (it|one of them), or undo your last change\.$/,
    );
    const last = must(rows().at(-1));
    expect(last.textContent).not.toMatch(/Lunch|Dinner/);
    await user.click(within(last).getByTestId("swap-button"));
    const [first] = await screen.findAllByTestId("alternative-option");
    const name = must(first?.querySelector(".t-tab")?.textContent, "the first option's name");
    // The first option is a place the chip named, as the day's dinner.
    expect(panel.textContent).toContain(name);
    await user.click(must(first));
    await waitFor(() => expect(rows().at(-1)?.textContent).toContain(name));
    expect(rows().at(-1)?.textContent).toContain("Dinner");
    expect(screen.queryAllByTestId("warning-chip").map((one) => one.textContent)).not.toContain(
      "No dinner planned",
    );
  });

  it("says a day where code added a meal was fixed after a check, with the rules' why line on it", async () => {
    // As POST /api/plan/day answers when the AI left out dinner and code added it (mealAdd.ts):
    // ai_repaired, the added stop with its rule reason.
    const added = vi.fn<PostDay>(async (body) => {
      const ai = dayAnswerFor(body);
      const rules = dayAnswerFor(body, "deterministic");
      const stops = ai.dayPlan.stops.map((stop, index) =>
        stop.role === "dinner" ? must(rules.dayPlan.stops[index]) : stop,
      );
      return { ...ai, source: "ai_repaired", dayPlan: { ...ai.dayPlan, stops } };
    });
    const { user } = setup({ postDay: added, post: async () => SATURDAY });
    await planAndOpen(user, 2);
    await user.click(screen.getByTestId("city-button"));
    await user.click(option("venice"));
    await user.click(within(sheet()).getByTestId("route-confirm"));
    await waitFor(() =>
      expect(screen.getByTestId("live-region").textContent).toContain("Day 2 now in Venice."),
    );
    await user.click(screen.getByTestId("day-tab-2"));
    expect(screen.getByTestId("day-source").textContent).toBe(
      "Planned again with AI, fixed after a check",
    );
    const rows = screen.getAllByTestId("stop-row");
    const dinner = must(
      rows.find((row) => row.textContent?.includes("Dinner")),
      "the dinner row",
    );
    const reason = within(dinner).getByTestId("stop-reason");
    expect(reason.textContent).toMatch(/^Why, from the rules: /);
    expect(reason.querySelector(".reason-mark--ai")).toBeNull();
    const others = rows.filter((row) => row !== dinner);
    for (const row of others) {
      expect(within(row).getByTestId("stop-reason").textContent).toContain(AI_DAY_REASON);
    }
  });
});
