import type { Itinerary, TripRequest } from "@italy/planner";
import { act, cleanup, configure, render, screen, waitFor, within } from "@testing-library/react";
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
import { AI_DAY_REASON, aiPlan, dayAnswer, must, tripData } from "./fixtures";

// Change city and New ideas for this day on the real page (F13): the city on a day's line opens
// the sheet with the planner's verdict for every base; choosing one asks POST /api/plan/day for
// that day while its board shows a skeleton and the rest of the trip stays in use; the answer
// goes in as one edit with Undo; and when the API cannot answer the day is planned here, labelled
// as a rules plan. What would break the product: a place on two days, a day shown as the AI's
// that the rules planned, focus lost as the sheet closes, or a saved trip that silently differs.

vi.mock("../components/DayMap", () => ({
  DayMap: ({ busy }: { busy?: boolean }) => (
    <div data-testid="day-map" data-busy={busy ? "true" : undefined} />
  ),
  prefetchMap: () => () => {},
}));

configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 20_000 });

type PostDay = (body: PlanDayBody, options: PlanCallOptions) => Promise<PlanDayResponse>;

/** Three days in Rome, planned with AI: day 3 can move at once; days 1 and 2 cannot. */
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

/**
 * What the API would answer for a request made from the plan as it arrived: every test here
 * changes one day of PLAN, so the trip the request describes is PLAN itself.
 */
const answerFor = (body: PlanDayBody) => dayAnswer(PLAN, body.day, body.anchorId);

/** A POST /api/plan/day that answers when the test says. */
function deferredDay() {
  let answer: () => void = () => {};
  const post = vi.fn<PostDay>(
    (body) =>
      new Promise<PlanDayResponse>((resolve) => {
        answer = () => resolve(answerFor(body));
      }),
  );
  return { post, answer: () => act(async () => answer()) };
}

/** POST /api/plan/day answering at once, like the API. */
const answering = vi.fn<PostDay>(async (body) => answerFor(body));

async function planAndOpen(user: ReturnType<typeof userEvent.setup>, day: number) {
  await user.click(await screen.findByTestId("plan-button"));
  await screen.findAllByTestId("stop-row");
  await user.click(screen.getByTestId(`day-tab-${day}`));
  return stopIds();
}

function stopIds(): string[] {
  return screen.queryAllByTestId("stop-row").map((row) => row.dataset.placeId ?? "");
}

async function tripIds(user: ReturnType<typeof userEvent.setup>): Promise<string[][]> {
  const days: string[][] = [];
  for (const day of [1, 2, 3]) {
    await user.click(screen.getByTestId(`day-tab-${day}`));
    days.push(stopIds());
  }
  return days;
}

function option(anchorId: string): HTMLElement {
  const sheet = screen.getByTestId("city-sheet");
  return must(
    within(sheet)
      .getAllByTestId("city-option")
      .find((element) => element.dataset.anchorId === anchorId),
    `the ${anchorId} option`,
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

describe("Change city", () => {
  it("opens from the city on the day's line with every base, the day's own first, and why one cannot be chosen", async () => {
    const { user } = setup({ postDay: answering });
    await planAndOpen(user, 2);
    const pill = screen.getByRole("button", { name: "Rome, change city" });
    expect(pill.getAttribute("aria-expanded")).toBe("false");
    await user.click(pill);

    const sheet = screen.getByTestId("city-sheet");
    expect(sheet.hasAttribute("open")).toBe(true);
    expect(pill.getAttribute("aria-expanded")).toBe("true");
    const title = within(sheet).getByRole("heading", { name: "Change city for day 2" });
    expect(document.activeElement).toBe(title);
    expect(within(sheet).getByText("Wednesday 7 October")).toBeTruthy();
    const current = within(sheet).getByTestId("city-current");
    expect(current.textContent).toContain("Rome");
    expect(current.textContent).toContain("This day");
    expect(within(current).getByRole("button", { name: "New ideas for this day" })).toBeTruthy();

    const options = within(sheet).getAllByTestId("city-option");
    expect(options.map((element) => element.dataset.anchorId)).toEqual([
      "florence",
      "milan",
      "venice",
      "bologna",
    ]);
    // Day 3 still starts in Rome, so none of them fits day 2 yet; each one says why, in place,
    // and none has the onward chevron.
    for (const element of options) {
      expect(element.getAttribute("aria-disabled")).toBe("true");
      expect(element.dataset.allowed).toBe("false");
      expect(element.querySelector(".city-option-chevron")).toBeNull();
    }
    const florence = option("florence");
    expect(florence).toHaveProperty("textContent", expect.stringContaining("Florence"));
    expect(screen.getByRole("button", { name: "Florence" }).getAttribute("aria-describedby")).toBe(
      within(florence).getByText(/Move day 3 to Florence first\.$/).id,
    );
    // A city the planner does not allow does nothing when pressed.
    await user.click(florence);
    expect(answering).not.toHaveBeenCalled();
    expect(sheet.hasAttribute("open")).toBe(true);

    // Closing puts focus back on the city it was opened from.
    await user.click(within(sheet).getByTestId("city-close"));
    expect(sheet.hasAttribute("open")).toBe(false);
    expect(document.activeElement).toBe(pill);
    expect(pill.getAttribute("aria-expanded")).toBe("false");
  });

  it("plans the chosen city's day while the rest of the trip stays in use, then puts it in as one edit", async () => {
    const day = deferredDay();
    const { user } = setup({ postDay: day.post });
    const before = await planAndOpen(user, 3);
    await user.click(screen.getByTestId("city-button"));
    const florence = option("florence");
    expect(florence.dataset.allowed).toBe("true");
    expect(florence.textContent).toContain("2 h 10 min by high-speed train from Rome, 22 places");
    expect(florence.querySelector(".city-option-chevron")).not.toBeNull();
    await user.click(florence);

    // The request: the trip as ids, the day and its new city, nothing to avoid.
    expect(day.post).toHaveBeenCalledTimes(1);
    const [body, options] = must(day.post.mock.calls[0]);
    expect(body).toEqual({
      request: PLAN.request,
      days: PLAN.days.map((planned) => ({
        anchorId: planned.anchorId,
        ids: planned.stops.map((stop) => stop.placeId),
      })),
      day: 2,
      anchorId: "florence",
    });
    expect(options.signal).toBeInstanceOf(AbortSignal);

    // While it works: the day says so, its board is a skeleton, its map waits, and focus is on
    // the day's heading, where the sheet left it.
    const board = screen.getByTestId("day-timetable");
    expect(board.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByTestId("day-planning").textContent).toBe("Planning day 3 in Florence");
    expect(screen.getByTestId("day-skeleton-rows")).toBeTruthy();
    expect(screen.queryAllByTestId("stop-row")).toHaveLength(0);
    expect(screen.getByTestId("day-map").dataset.busy).toBe("true");
    expect(document.activeElement).toBe(document.getElementById("day-heading-2"));
    expect(screen.getByTestId("live-region").textContent).toBe("Planning day 3 in Florence.");
    // The other days stay in use; their city waits until this day is planned.
    await user.click(screen.getByTestId("day-tab-1"));
    expect(screen.getAllByTestId("stop-row").length).toBeGreaterThan(0);
    expect(screen.getByTestId("city-button").getAttribute("aria-disabled")).toBe("true");
    await user.click(screen.getByTestId("city-button"));
    expect(screen.getByTestId("city-sheet").hasAttribute("open")).toBe(false);
    await user.click(screen.getByTestId("day-tab-3"));

    await day.answer();

    expect(screen.queryByTestId("day-planning")).toBeNull();
    expect(screen.getByTestId("day-subtitle").textContent).toContain("Day 3 in Florence");
    expect(screen.getByTestId("day-source").textContent).toBe("Planned again with AI");
    expect(screen.getByTestId("day-source").dataset.marker).toBe("ai");
    const after = stopIds();
    expect(after.length).toBeGreaterThan(0);
    expect(after.some((id) => before.includes(id))).toBe(false);
    // The AI's words, with their AI marks.
    const reasons = screen.getAllByTestId("stop-reason");
    expect(reasons.some((reason) => reason.textContent?.includes(AI_DAY_REASON))).toBe(true);
    expect(reasons[0]?.textContent).toContain("Why, from the AI planner:");
    expect(screen.getByTestId("source-badge").textContent).toContain("Planned with AI, edited");
    expect(screen.getByTestId("live-region").textContent).toBe("Day 3 now in Florence.");
    const toast = screen.getByTestId("toast");
    expect(toast.textContent).toContain("Day 3 now in Florence.");
    expect(within(toast).getByTestId("toast-undo").textContent).toBe("Undo city change");
    expect(screen.getByTestId("day-map").dataset.busy).toBeUndefined();

    // No place is on two days.
    const trip = await tripIds(user);
    expect(new Set(trip.flat()).size).toBe(trip.flat().length);

    // One Undo brings the day back exactly, in Rome, with nothing said under it.
    await user.click(screen.getByTestId("undo-button"));
    expect(screen.getByTestId("day-timetable").dataset.day).toBe("3");
    expect(stopIds()).toEqual(before);
    expect(screen.getByTestId("day-subtitle").textContent).toContain("Day 3 in Rome");
    expect(screen.queryByTestId("day-source")).toBeNull();
    expect(screen.queryByTestId("undo-button")).toBeNull();
    expect(screen.getByTestId("source-badge").textContent).not.toContain("edited");
  });

  it("gives new ideas for a day in its own city, leaving out the places it has", async () => {
    const { user } = setup({ postDay: answering });
    const before = await planAndOpen(user, 2);
    await user.click(screen.getByTestId("city-button"));
    await user.click(screen.getByRole("button", { name: "New ideas for this day" }));

    const body = must(answering.mock.calls[0])[0];
    expect(body).toMatchObject({ day: 1, anchorId: "rome", avoid: before });
    await waitFor(() => expect(screen.getByTestId("day-source")).toBeTruthy());
    const after = stopIds();
    expect(after.some((id) => before.includes(id))).toBe(false);
    expect(screen.getByTestId("day-subtitle").textContent).toContain("Day 2 in Rome");
    expect(screen.getByTestId("live-region").textContent).toBe("New ideas for day 2.");
    // Focus stayed on the day's heading, where the sheet left it, so reading starts there.
    expect(document.activeElement).toBe(document.getElementById("day-heading-1"));
    expect(screen.getByTestId("undo-button").textContent).toContain("Undo new ideas");
    // The trip's summary still holds: the day is in the same city.
    expect(screen.getByTestId("plan-summary").textContent).toBe("Three days of food in Rome.");
  });

  it("plans the day on this device when the API cannot answer, and labels it as a rules plan", async () => {
    const postDay = vi.fn<PostDay>(async () => {
      throw new ApiError({ kind: "network", message: "offline" });
    });
    const { user } = setup({ postDay });
    const before = await planAndOpen(user, 3);
    await user.click(screen.getByTestId("city-button"));
    await user.click(option("venice"));

    await waitFor(() => expect(screen.getByTestId("day-source")).toBeTruthy());
    expect(screen.getByTestId("day-source").textContent).toBe(
      "Planned again on this device, offline",
    );
    expect(screen.getByTestId("day-source").dataset.marker).toBe("rules");
    expect(screen.getByTestId("day-subtitle").textContent).toContain("Day 3 in Venice");
    const after = stopIds();
    expect(after.length).toBeGreaterThan(0);
    expect(after.some((id) => before.includes(id))).toBe(false);
    for (const reason of screen.getAllByTestId("stop-reason")) {
      expect(reason.textContent).toContain("Why, from the rules:");
    }
    expect(screen.getByTestId("live-region").textContent).toBe(
      "Day 3 now in Venice. Planned without AI on this device.",
    );
    // Flagged nowhere: the rules' day passes the same check.
    expect(document.querySelector('[data-flagged="true"]')).toBeNull();
  });

  it("says after a while that the day is still being planned", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const day = deferredDay();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(
      <PlannerApp
        loader={async () => tripData()}
        post={async () => PLAN}
        postDay={day.post}
        today={() => new Date(2026, 8, 23)}
      />,
    );
    await planAndOpen(user, 3);
    await user.click(screen.getByTestId("city-button"));
    await user.click(option("florence"));
    expect(screen.queryByTestId("day-planning-slow")).toBeNull();
    await act(async () => vi.advanceTimersByTime(SLOW_PLAN_MS));
    expect(screen.getByTestId("day-planning-slow").textContent).toBe(
      "Still working. If the AI planner takes too long, the day is planned with rules.",
    );
    await day.answer();
    expect(screen.queryByTestId("day-planning-slow")).toBeNull();
  });

  it("gives up a day still on its way when a new plan arrives", async () => {
    const day = deferredDay();
    const post = vi.fn(async () => PLAN);
    const { user } = setup({ postDay: day.post, post });
    const before = await planAndOpen(user, 3);
    await user.click(screen.getByTestId("city-button"));
    await user.click(option("florence"));
    expect(screen.getByTestId("day-planning")).toBeTruthy();

    // Another pace: a new plan from the Edit trip sheet.
    await user.click(screen.getByTestId("edit-trip-button"));
    await user.click(screen.getByRole("radio", { name: "Packed" }));
    await user.click(screen.getByTestId("plan-button"));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByTestId("day-planning")).toBeNull());
    const signal = must(day.post.mock.calls[0])[1].signal;
    expect(signal?.aborted).toBe(true);
    await day.answer();
    await user.click(screen.getByTestId("day-tab-3"));
    expect(stopIds()).toEqual(before);
    expect(screen.queryByTestId("day-source")).toBeNull();
  });

  it("saves the trip with the new day's ids and says which day shows the rules' why lines", async () => {
    const saveTrip = vi.fn(async (_body: SaveTripBody) => "a1B2c3D4e5");
    const { user } = setup({ postDay: answering, saveTrip });
    await planAndOpen(user, 3);
    const writeText = vi.fn(async (_text: string) => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    await user.click(screen.getByTestId("city-button"));
    await user.click(option("florence"));
    await waitFor(() => expect(screen.getByTestId("day-source")).toBeTruthy());
    const dayThree = stopIds();

    await user.click(screen.getByTestId("share-button"));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const body = must(saveTrip.mock.calls[0])[0];
    expect(body.planId).toBe("Zz9Yy8Xx7W");
    expect(body.days[2]).toEqual({ anchorId: "florence", ids: dayThree });
    expect(body.days[0]?.ids).toEqual(PLAN.days[0]?.stops.map((stop) => stop.placeId));
    const note = must(replannedNote([3]));
    await waitFor(() => expect(screen.getByTestId("share-note").textContent).toBe(note));
    expect(screen.getByTestId("live-region").textContent).toBe(`Link copied. ${note}`);
  });

  it("keeps the day's line after the app is reopened", async () => {
    const { user } = setup({ postDay: answering });
    await planAndOpen(user, 3);
    await user.click(screen.getByTestId("city-button"));
    await user.click(option("florence"));
    await waitFor(() => expect(screen.getByTestId("day-source")).toBeTruthy());
    const stored = JSON.parse(window.localStorage.getItem(LAST_PLAN_KEY) ?? "{}");
    expect(stored.days).toEqual([null, null, { kind: "api", source: "ai" }]);

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
    await userEvent.setup().click(screen.getByTestId("day-tab-3"));
    expect(screen.getByTestId("day-source").textContent).toBe("Planned again with AI");
    expect(screen.getByTestId("source-badge").textContent).toContain("edited");
  });

  it("says the day was edited once a stop on it changes after it was planned again", async () => {
    const { user } = setup({ postDay: answering });
    await planAndOpen(user, 3);
    await user.click(screen.getByTestId("city-button"));
    await user.click(option("florence"));
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
    const postDay = vi.fn<PostDay>(async (body) => dayAnswer(rome, body.day, body.anchorId));
    const { user } = setup({ postDay, post: async () => rome });
    await planAndOpen(user, 3);
    await user.click(screen.getByTestId("city-button"));
    await user.click(option("florence"));
    await waitFor(() => expect(screen.getByTestId("day-source")).toBeTruthy());
    expect(screen.getByTestId("day-subtitle").textContent).toContain("Day 3 in Florence");
    const labels = screen.queryAllByTestId("warning-chip").map((chip) => chip.textContent);
    expect(labels.some((label) => label?.includes("Not one of your bases"))).toBe(false);
    expect(screen.queryByText(/not one of the bases you chose/)).toBeNull();
  });
});
