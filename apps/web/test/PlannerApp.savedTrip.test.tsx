import { dataVersion, type Itinerary, privateAiText, type TripRequest } from "@italy/planner";
import { act, cleanup, configure, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlannerApp } from "../components/PlannerApp";
import type { SaveTrip } from "../components/ShareButton";
import type { SaveTripBody } from "../lib/api";
import { ApiError } from "../lib/apiError";
import type { SavedTripResponse } from "../lib/apiSchemas";
import { privateNote } from "../lib/copyLink";
import { LAST_PLAN_KEY } from "../lib/lastPlan";
import { type FetchTrip, SAVED_NOTES } from "../lib/savedTrip";
import { encodeShare } from "../lib/shareLink";
import { aiPlan, fixturePlan, must, place, places, tripData } from "./fixtures";

// Saved trips on the real page: Copy link saves the trip and copies ?t=, and opening ?t= shows
// the trip exactly as saved, or timed again when the place data changed, or a plain note over
// the form when it cannot be opened.

vi.mock("../components/DayMap", () => ({
  DayMap: () => <div data-testid="day-map" />,
  prefetchMap: () => () => {},
}));

configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 20_000 });

const TODAY = () => new Date(2026, 8, 23);
const ID = "a1B2c3D4e5";

function savedTrip(overrides: Partial<SavedTripResponse> = {}): SavedTripResponse {
  return {
    v: 1,
    id: ID,
    itinerary: aiPlan() as SavedTripResponse["itinerary"],
    origin: { plannedBy: "ai", edited: false },
    dataVersion: dataVersion(places),
    createdAt: "2026-09-20T12:00:00.000Z",
    ...overrides,
  };
}

interface Setup {
  post?: (request: TripRequest) => Promise<Itinerary>;
  saveTrip?: SaveTrip;
  fetchTrip?: FetchTrip;
}

function setup({ post = async () => aiPlan(), saveTrip, fetchTrip }: Setup = {}) {
  const user = userEvent.setup();
  render(
    <PlannerApp
      loader={async () => tripData()}
      post={post}
      today={TODAY}
      {...(saveTrip ? { saveTrip } : {})}
      {...(fetchTrip ? { fetchTrip } : {})}
    />,
  );
  return { user };
}

function stubClipboard() {
  const writeText = vi.fn(async (_text: string) => {});
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  return writeText;
}

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Copy link saves the trip", () => {
  it("sends the plan's ids and planId, and copies the saved trip's short link", async () => {
    const saveTrip = vi.fn(async (_body: SaveTripBody) => ID);
    const plan = { ...aiPlan(), planId: "Zz9Yy8Xx7W" };
    const { user } = setup({ post: async () => plan, saveTrip });
    const writeText = stubClipboard(); // after setup, which installs user-event's own clipboard
    await user.click(await screen.findByTestId("plan-button"));
    await screen.findAllByTestId("stop-row");

    await user.click(screen.getByTestId("share-button"));

    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(new URL(writeText.mock.calls[0]?.[0] as string).search).toBe(`?t=${ID}`);
    const body = saveTrip.mock.calls[0]?.[0] as SaveTripBody;
    expect(body.planId).toBe("Zz9Yy8Xx7W");
    expect(body.days[0]?.ids).toEqual(plan.days[0]?.stops.map((stop) => stop.placeId));
    await waitFor(() => expect(screen.getByTestId("live-region").textContent).toBe("Link copied."));
  });

  it("copies the rebuild-from-places link when saving fails, and says so under the header", async () => {
    const { user } = setup({ saveTrip: () => Promise.reject(new Error("offline")) });
    const writeText = stubClipboard();
    await user.click(await screen.findByTestId("plan-button"));
    await screen.findAllByTestId("stop-row");

    await user.click(screen.getByTestId("share-button"));

    expect((await screen.findByTestId("share-note")).textContent).toContain(
      "the saved link could not be made",
    );
    expect(new URL(writeText.mock.calls[0]?.[0] as string).searchParams.has("p")).toBe(true);
  });
});

describe("what Copy link says about the trip", () => {
  it("says what the shared trip leaves out when the plan was made with notes", async () => {
    const plan = { ...aiPlan({ notes: "I had knee surgery." }), planId: "Zz9Yy8Xx7W" };
    const { user } = setup({ post: async () => plan, saveTrip: async () => ID });
    stubClipboard();
    await user.click(await screen.findByTestId("plan-button"));
    await screen.findAllByTestId("stop-row");

    await user.click(screen.getByTestId("share-button"));

    const note = must(privateNote(privateAiText(plan)), "a note");
    expect((await screen.findByTestId("share-note")).textContent).toBe(note);
    await waitFor(() =>
      expect(screen.getByTestId("live-region").textContent).toBe(
        "Link copied. To keep your notes private, the shared trip leaves out the AI's summary and why lines.",
      ),
    );
  });

  it("copies the rebuild link without saving when the plan breaks a rule", async () => {
    // A kept plan whose second stop now starts during the first: restored, and flagged.
    const plan = aiPlan();
    const day0 = must(plan.days[0], "day 0");
    const [first, second, ...rest] = day0.stops;
    const start = must(first, "first stop").start + 5;
    const overlap = { ...must(second, "second stop"), start, end: start + 60 };
    const broken = {
      ...plan,
      days: [{ ...day0, stops: [must(first, "first"), overlap, ...rest] }, ...plan.days.slice(1)],
    };
    const record = { v: 1, savedAt: TODAY().toISOString(), origin: "api", itinerary: broken };
    window.localStorage.setItem(LAST_PLAN_KEY, JSON.stringify(record));
    const saveTrip = vi.fn(async (_body: SaveTripBody) => ID);
    const { user } = setup({ saveTrip });
    const writeText = stubClipboard();
    await screen.findAllByTestId("stop-row");
    expect(document.querySelector('[data-flagged="true"]')).not.toBeNull();

    await user.click(screen.getByTestId("share-button"));

    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(saveTrip).not.toHaveBeenCalled();
    expect(new URL(writeText.mock.calls[0]?.[0] as string).searchParams.has("p")).toBe(true);
    // One stop is flagged, so the note names one stop.
    expect(document.querySelectorAll('[data-flagged="true"]')).toHaveLength(1);
    expect((await screen.findByTestId("share-note")).textContent).toBe(
      "This plan has a stop that breaks a rule, so it is not saved. The link rebuilds it from its places and leaves that stop out if it still breaks a rule.",
    );
  });
});

describe("the AI summary on the page", () => {
  it("drops a sentence about a stop the traveler removes, as the saved trip will, and undo brings it back", async () => {
    const base = aiPlan();
    const stops = base.days[0]?.stops ?? [];
    const index = stops.findIndex((stop, at) => at > 0 && !place(stop.placeId).name.includes("."));
    const name = place(stops[index]?.placeId ?? "").name;
    const summary = `${name} is a highlight of the first day. A calm pace throughout.`;
    const { user } = setup({ post: async () => ({ ...base, summary }) });
    await user.click(await screen.findByTestId("plan-button"));
    const rows = await screen.findAllByTestId("stop-row");
    expect(screen.getByTestId("plan-summary").textContent).toBe(summary);

    await user.click(within(rows[index] as HTMLElement).getByTestId("remove-button"));

    await waitFor(() =>
      expect(screen.getByTestId("plan-summary").textContent).toBe("A calm pace throughout."),
    );
    await user.click(screen.getByTestId("undo-button"));
    await waitFor(() => expect(screen.getByTestId("plan-summary").textContent).toBe(summary));
  });
});

describe("opening a saved trip link", () => {
  it("shows the trip exactly as saved, says it is a saved trip, and removes ?t=", async () => {
    window.history.replaceState(null, "", `/?t=${ID}`);
    const trip = savedTrip();
    const fetchTrip = vi.fn(async () => trip);
    setup({ fetchTrip });

    const rows = await screen.findAllByTestId("stop-row");

    expect(rows.map((row) => row.dataset.placeId)).toEqual(
      trip.itinerary.days[0]?.stops.map((stop) => stop.placeId),
    );
    expect(fetchTrip).toHaveBeenCalledWith(ID);
    expect(screen.getByTestId("source-badge").textContent).toContain(
      "Saved trip, planned with AI, saved 20 Sep",
    );
    expect(screen.getByTestId("source-badge").dataset.marker).toBe("ai");
    expect(screen.getByTestId("plan-summary").textContent).toBe(trip.itinerary.summary);
    expect(screen.queryByTestId("share-notice")).toBeNull();
    await waitFor(() =>
      expect(screen.getByTestId("live-region").textContent).toBe("Opened a saved trip."),
    );
    expect(window.location.search).toBe("");
  });

  it("keeps the plan's skeleton up while the trip is on its way, then shows it", async () => {
    window.history.replaceState(null, "", `/?t=${ID}`);
    let answer: (trip: SavedTripResponse) => void = () => {};
    setup({ fetchTrip: () => new Promise((resolve) => (answer = resolve)) });

    await waitFor(() => expect(screen.getByTestId("planner-app").dataset.view).toBe("plan"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByTestId("planner-app").dataset.view).toBe("plan");
    expect(screen.queryByTestId("stop-row")).toBeNull();

    await act(async () => answer(savedTrip()));
    expect(await screen.findAllByTestId("stop-row")).not.toHaveLength(0);
  });

  it("saves the trip again from the one it was opened from, so its why lines carry over", async () => {
    window.history.replaceState(null, "", `/?t=${ID}`);
    const saveTrip = vi.fn(async (_body: SaveTripBody) => "Zz9Yy8Xx7W");
    const { user } = setup({ fetchTrip: async () => savedTrip(), saveTrip });
    stubClipboard();
    await screen.findAllByTestId("stop-row");

    await user.click(screen.getByTestId("share-button"));

    await waitFor(() => expect(saveTrip).toHaveBeenCalled());
    expect(saveTrip.mock.calls[0]?.[0]).toMatchObject({ tripId: ID });
  });

  it("times the trip again and says so when the place data has changed since it was saved", async () => {
    window.history.replaceState(null, "", `/?t=${ID}`);
    setup({ fetchTrip: async () => savedTrip({ dataVersion: "0123456789abcdef" }) });

    await screen.findAllByTestId("stop-row");

    expect(screen.getByTestId("share-notice").textContent).toContain(
      "The place data has changed since it was saved, so its times were worked out again",
    );
    expect(screen.getByTestId("source-badge").textContent).toContain(
      "Saved trip, planned with AI, saved 20 Sep",
    );
    expect(screen.getByTestId("source-badge").dataset.marker).toBe("rules");
    expect(window.location.search).toBe("");
    await waitFor(() =>
      expect(JSON.parse(window.localStorage.getItem(LAST_PLAN_KEY) ?? "{}").origin).toBe("saved"),
    );
    cleanup();

    // After a reload the note still says the times were worked out again.
    setup();

    await screen.findAllByTestId("stop-row");
    expect(screen.getByTestId("share-notice").textContent).toContain(
      "It is a saved trip whose times were worked out again with newer place data",
    );
  });

  it("says plainly over the form when the saved trip does not exist", async () => {
    window.history.replaceState(null, "", `/?t=${ID}`);
    const missing = new ApiError({ kind: "http", status: 404, message: "Not found" });
    setup({ fetchTrip: () => Promise.reject(missing) });

    expect((await screen.findByTestId("share-notice")).textContent).toBe(
      "This saved trip could not be found. Plan a new trip with the form.",
    );
    expect(screen.getByTestId("trip-form")).toBeTruthy();
    expect(screen.queryAllByTestId("stop-row")).toHaveLength(0);
    expect(window.location.search).toBe("");
  });

  it("asks to open the link again after a network failure, and keeps ?t= for a reload", async () => {
    window.history.replaceState(null, "", `/?t=${ID}`);
    const offline = new ApiError({ kind: "network", message: "offline" });
    setup({ fetchTrip: () => Promise.reject(offline) });

    expect((await screen.findByTestId("share-notice")).textContent).toBe(
      "The saved trip could not be loaded. Check the connection and open the link again.",
    );
    expect(screen.getByTestId("plan-button")).toBeTruthy();
    expect(window.location.search).toBe(`?t=${ID}`);
  });

  it("says it will open once the connection is back, and opens it on Try again, after opening with the API down", async () => {
    window.history.replaceState(null, "", `/?t=${ID}`);
    const down = () => new ApiError({ kind: "network", message: "offline" });
    let loads = 0;
    const loader = async () => {
      loads += 1;
      if (loads === 1) throw down();
      return tripData();
    };
    let fetches = 0;
    const fetchTrip = vi.fn(async () => {
      fetches += 1;
      if (fetches === 1) throw down();
      return savedTrip();
    });
    const user = userEvent.setup();
    render(
      <PlannerApp
        loader={loader}
        post={async () => aiPlan()}
        today={TODAY}
        fetchTrip={fetchTrip}
      />,
    );
    await waitFor(() => expect(screen.getByTestId("planner-app").dataset.view).toBe("compose"));
    expect(fetchTrip).toHaveBeenCalledTimes(1);
    expect((await screen.findByTestId("share-notice")).textContent).toBe(
      "The saved trip will open once the connection is back.",
    );

    await user.click(await screen.findByTestId("options-retry"));

    const rows = await screen.findAllByTestId("stop-row");
    expect(rows.length).toBeGreaterThan(0);
    expect(fetchTrip).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("share-notice")).toBeNull();
    expect(screen.getByTestId("source-badge").textContent).toContain("Saved trip");
    expect(window.location.search).toBe("");
  });

  it("says it was edited after a reload", async () => {
    window.history.replaceState(null, "", `/?t=${ID}`);
    const { user } = setup({ fetchTrip: async () => savedTrip() });
    const rows = await screen.findAllByTestId("stop-row");
    await user.click(within(rows[1] as HTMLElement).getByTestId("remove-button"));
    await waitFor(() =>
      expect(JSON.parse(window.localStorage.getItem(LAST_PLAN_KEY) ?? "{}").edited).toBe(true),
    );
    cleanup();

    setup();

    await screen.findAllByTestId("stop-row");
    expect(screen.getByTestId("source-badge").textContent).toContain(
      "Saved trip, planned with AI, saved 20 Sep, edited",
    );
    expect(screen.queryByTestId("share-notice")).toBeNull();
  });

  it("wins over the plan kept on this device, and is kept as a saved trip after a reload", async () => {
    window.localStorage.setItem(
      LAST_PLAN_KEY,
      JSON.stringify({ v: 1, savedAt: TODAY().toISOString(), origin: "api", itinerary: aiPlan() }),
    );
    window.history.replaceState(null, "", `/?t=${ID}`);
    setup({ fetchTrip: async () => savedTrip() });
    await screen.findAllByTestId("stop-row");
    await waitFor(() =>
      expect(JSON.parse(window.localStorage.getItem(LAST_PLAN_KEY) ?? "{}").origin).toBe("saved"),
    );
    cleanup();

    setup();

    await screen.findAllByTestId("stop-row");
    expect(screen.getByTestId("source-badge").textContent).toContain(
      "Saved trip, planned with AI, saved 20 Sep",
    );
  });
});

describe("a link still on its way when the traveler plans a trip", () => {
  const down = () => new ApiError({ kind: "network", message: "offline" });

  /** Places that fail to load the first time (the API is down), then load on Try again. */
  function placesDownOnce() {
    let loads = 0;
    return async () => {
      loads += 1;
      if (loads === 1) throw down();
      return tripData();
    };
  }

  /** Plans a trip from the form while the places are missing, then brings them with Try again. */
  async function planThenRetry(user: ReturnType<typeof userEvent.setup>) {
    await waitFor(() => expect(screen.getByTestId("planner-app").dataset.view).toBe("compose"));
    await user.click(screen.getByTestId("plan-button"));
    const unavailable = await screen.findByTestId("error-state");
    await user.click(within(unavailable).getByTestId("retry-button"));
    return screen.findAllByTestId("stop-row");
  }

  it("gives up a saved trip: the traveler's plan shows, the trip never opens, and ?t= goes", async () => {
    window.history.replaceState(null, "", `/?t=${ID}`);
    const fetchTrip = vi.fn(async (): Promise<SavedTripResponse> => {
      throw down();
    });
    const mine = aiPlan({ pace: "relaxed" });
    const user = userEvent.setup();
    render(
      <PlannerApp
        loader={placesDownOnce()}
        post={async () => mine}
        today={TODAY}
        fetchTrip={fetchTrip}
      />,
    );
    expect((await screen.findByTestId("share-notice")).textContent).toBe(SAVED_NOTES.waiting);

    const rows = await planThenRetry(user);

    expect(rows.map((row) => row.dataset.placeId)).toEqual(
      mine.days[0]?.stops.map((stop) => stop.placeId),
    );
    expect(screen.getByTestId("source-badge").textContent).not.toContain("Saved trip");
    expect(screen.queryByTestId("share-notice")).toBeNull();
    expect(fetchTrip).toHaveBeenCalledTimes(1); // not fetched again once the places loaded
    expect(window.location.search).toBe("");
  });

  it("ignores a saved trip that arrives after the traveler planned their own", async () => {
    window.history.replaceState(null, "", `/?t=${ID}`);
    let answer: (trip: SavedTripResponse) => void = () => {};
    const fetchTrip = () => new Promise<SavedTripResponse>((resolve) => (answer = resolve));
    const mine = aiPlan({ pace: "relaxed" });
    const user = userEvent.setup();
    render(
      <PlannerApp
        loader={placesDownOnce()}
        post={async () => mine}
        today={TODAY}
        fetchTrip={fetchTrip}
      />,
    );

    await planThenRetry(user);
    await act(async () => answer(savedTrip()));

    expect(screen.getByTestId("source-badge").textContent).not.toContain("Saved trip");
    expect(screen.getByTestId("trip-summary-meta").textContent).toContain("Relaxed pace");
    expect(window.location.search).toBe("");
  });

  it("gives up a shared link: the traveler's plan shows, and ?p= goes", async () => {
    const shared = fixturePlan({ pace: "packed" });
    window.history.replaceState(null, "", `/?p=${encodeShare(shared)}`);
    const mine = aiPlan({ pace: "relaxed" });
    const user = userEvent.setup();
    render(<PlannerApp loader={placesDownOnce()} post={async () => mine} today={TODAY} />);

    const rows = await planThenRetry(user);

    expect(rows.map((row) => row.dataset.placeId)).toEqual(
      mine.days[0]?.stops.map((stop) => stop.placeId),
    );
    expect(screen.getByTestId("source-badge").textContent).not.toContain("Shared plan");
    expect(screen.queryByTestId("share-notice")).toBeNull();
    expect(window.location.search).toBe("");
  });
});
