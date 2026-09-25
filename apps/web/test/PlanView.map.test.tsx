import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlanView } from "../components/PlanView";
import { type ItineraryState, initialItineraryState } from "../lib/itineraryReducer";
import { mapDayTitle } from "../lib/mapPoints";
import { buildTripView } from "../lib/timetable";
import * as fake from "./fakeMapLibre";
import { ctx, fixturePlan, must } from "./fixtures";

// The board and the map share one details sheet: a stop's marker (on the page or full screen)
// opens the same sheet as its Details button, for the same stop, and closing it gives focus back
// to whatever opened it. The full-screen map's day switcher is the page's own day selection.
// The map's code is loaded at once here (next/dynamic stands aside) and MapLibre is faked.

vi.mock("maplibre-gl", async () => (await import("./fakeMapLibre")).maplibre);
vi.mock("next/dynamic", async () => {
  const inner = await import("../components/DayMapInner");
  return { default: () => inner.default };
});

const plan: ItineraryState = { ...initialItineraryState(), itinerary: fixturePlan(), planId: 1 };
const days = buildTripView(fixturePlan(), ctx, []);

function Page() {
  const [active, setActive] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  return (
    <PlanView
      plan={plan}
      ctx={ctx}
      activeDay={active}
      animateDay={-1}
      headingRef={heading}
      onSelectDay={setActive}
      onSwap={() => {}}
      onRemove={() => {}}
      onMove={() => {}}
    />
  );
}

const sheet = () => screen.getByTestId("details-sheet") as HTMLDialogElement;
const mapDialog = () => screen.getByTestId("map-dialog") as HTMLDialogElement;

beforeEach(() => {
  fake.resetFake();
  vi.stubGlobal("WebGL2RenderingContext", class {});
  fake.stubMedia();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("the plan's map and board", () => {
  it("open one details sheet: a marker's popup opens the stop the board's Details opens", async () => {
    const user = userEvent.setup();
    render(<Page />);
    expect(screen.getAllByTestId("details-sheet")).toHaveLength(1);
    const view = must(days[0]);
    const row = must(view.rows[1]);
    const marker = must(screen.getAllByTestId("map-stop")[1]);
    await user.hover(marker);
    await user.click(await screen.findByTestId("map-popup"));
    expect(sheet().open).toBe(true);
    expect(screen.getByTestId("details-title").textContent).toBe(row.place?.name);
    // The board's Details for that stop says its sheet is open.
    const details = must(
      screen.getAllByTestId("stop-row").find((item) => item.dataset.placeId === row.stop.placeId),
    );
    expect(within(details).getByTestId("details-button").getAttribute("aria-expanded")).toBe(
      "true",
    );
    await user.keyboard("{Escape}");
    expect(sheet().open).toBe(false);
    // Focus goes back to the marker that opened it.
    expect(document.activeElement).toBe(marker);
  });

  it("opens the same sheet from the board, and gives focus back to the board", async () => {
    const user = userEvent.setup();
    render(<Page />);
    const row = must(days[0]?.rows[0]);
    const button = must(screen.getAllByTestId("details-button")[0]);
    await user.click(button);
    expect(sheet().open).toBe(true);
    expect(screen.getByTestId("details-title").textContent).toBe(row.place?.name);
    await user.click(screen.getByRole("button", { name: "Close details" }));
    expect(document.activeElement).toBe(button);
  });

  it("opens the sheet over the full-screen map, and returns focus to the marker in it", async () => {
    const user = userEvent.setup();
    render(<Page />);
    await user.click(screen.getByRole("button", { name: "Expand map" }));
    expect(mapDialog().open).toBe(true);
    const marker = must(within(mapDialog()).getAllByTestId("map-stop")[2]);
    await user.click(marker);
    expect(sheet().open).toBe(true);
    expect(screen.getByTestId("details-title").textContent).toBe(days[0]?.rows[2]?.place?.name);
    // The sheet stacks over the map, which stays open beneath it.
    expect(mapDialog().open).toBe(true);
    await user.keyboard("{Escape}");
    expect(sheet().open).toBe(false);
    expect(mapDialog().open).toBe(true);
    expect(document.activeElement).toBe(marker);
  });

  it("steps from a marker's stop to the next, marks it open on the board, and closes onto its marker", async () => {
    const user = userEvent.setup();
    render(<Page />);
    const view = must(days[0]);
    const markers = screen.getAllByTestId("map-stop");
    await user.hover(must(markers[1]));
    await user.click(await screen.findByTestId("map-popup"));
    await user.click(screen.getByTestId("details-next"));
    const shown = must(view.rows[2]);
    expect(screen.getByTestId("details-title").textContent).toBe(shown.place?.name);
    // The board's Details now says the stop shown is the one open, and the first no longer is.
    const expanded = screen
      .getAllByTestId("details-button")
      .map((button) => button.getAttribute("aria-expanded"));
    expect(expanded.slice(0, 3)).toEqual(["false", "false", "true"]);
    await user.keyboard("{Escape}");
    expect(sheet().open).toBe(false);
    // Focus lands on the stop now shown, on the map that opened the sheet.
    expect(document.activeElement).toBe(markers[2]);
  });

  it("steps over the full-screen map and closes onto the marker of the stop shown there", async () => {
    const user = userEvent.setup();
    render(<Page />);
    await user.click(screen.getByRole("button", { name: "Expand map" }));
    const markers = within(mapDialog()).getAllByTestId("map-stop");
    await user.click(must(markers[3]));
    await user.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(screen.getByTestId("details-title").textContent).toBe(days[0]?.rows[1]?.place?.name);
    await user.keyboard("{Escape}");
    expect(mapDialog().open).toBe(true);
    expect(document.activeElement).toBe(markers[1]);
  });

  it("switches the page's day from the full-screen map", async () => {
    const user = userEvent.setup();
    render(<Page />);
    await user.click(screen.getByRole("button", { name: "Expand map" }));
    const third = must(days[2]);
    await user.click(screen.getByRole("radio", { name: mapDayTitle(third) }));
    expect(screen.getByTestId("map-dialog-title").textContent).toBe(mapDayTitle(third));
    // The page behind follows: its tab and its board are on the same day.
    expect(screen.getByTestId("day-tab-3").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("day-timetable").dataset.day).toBe("3");
    await user.click(screen.getByRole("button", { name: "Close map" }));
    await waitFor(() => expect(mapDialog().open).toBe(false));
    expect(screen.getByText(/^Map of day 3\./)).toBeTruthy();
  });

  it("closes a stop's sheet for good when its day gives way to one without that stop", () => {
    render(<Page />);
    const row = must(days[0]?.rows[0]);
    act(() => must(screen.getAllByTestId("details-button")[0]).click());
    expect(screen.getByTestId("details-title").textContent).toBe(row.place?.name);
    // jsdom leaves the page usable under a sheet, so the day can change beneath it.
    act(() => screen.getByTestId("day-tab-2").click());
    expect(sheet().open).toBe(false);
    act(() => screen.getByTestId("day-tab-1").click());
    expect(sheet().open).toBe(false);
  });
});
