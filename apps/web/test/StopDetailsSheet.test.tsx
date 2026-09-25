import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DayTimetable } from "../components/DayTimetable";
import { StopDetailsSheet } from "../components/StopDetailsSheet";
import { photoForPlace } from "../lib/placePhotos";
import { buildDayView, type RowView } from "../lib/timetable";
import { ctx, fixturePlan, must } from "./fixtures";

// A stop's details open in a sheet over the board, from the stop's photo or its Details button:
// the place's name as the title with its subtitle, the photo large with its credit, the facts for
// the date, what the data cannot confirm and the listing's own words. Escape or the close pill
// shuts it and gives focus back to whatever opened it; nothing opens inside the row any more.

afterEach(cleanup);

const plan = fixturePlan();
const view = must(buildDayView(plan, 0, ctx, []));

function renderDay() {
  const user = userEvent.setup();
  const handlers = { onSwap: vi.fn(), onRemove: vi.fn(), onMove: vi.fn() };
  render(<DayTimetable view={view} animate={false} changedStop={null} {...handlers} />);
  return { user, handlers };
}

/** The board's row for `row`, found by its place. */
function rowElement(row: RowView): HTMLElement {
  return must(
    screen.getAllByTestId("stop-row").find((item) => item.dataset.placeId === row.stop.placeId),
    "row on the board",
  );
}

const sheet = () => screen.getByTestId("details-sheet") as HTMLDialogElement;

const described = must(
  view.rows.find((row) => (row.place?.description.trim() ?? "") !== ""),
  "a stop with a description",
);

describe("the stop details sheet", () => {
  it("opens from Details, titled with the place, with the facts for its date and the listing's words", async () => {
    const { user } = renderDay();
    const place = must(described.place);
    expect(sheet().open).toBe(false);
    const details = within(rowElement(described)).getByTestId("details-button");
    await user.click(details);
    expect(sheet().open).toBe(true);
    expect(details.getAttribute("aria-expanded")).toBe("true");
    expect(details.getAttribute("aria-controls")).toBe(sheet().id);
    const title = screen.getByTestId("details-title");
    expect(title.textContent).toBe(place.name);
    expect(sheet().getAttribute("aria-labelledby")).toBe(title.id);
    expect(document.activeElement).toBe(title);
    // The subtitle sits under the name, as on the row.
    expect(title.parentElement?.querySelector(".stop-subtitle")?.textContent).toMatch(/ in /);
    const facts = within(sheet()).getByTestId("stop-fact-sheet");
    const terms = [...facts.querySelectorAll("dt")].map((term) => term.textContent);
    expect(terms[0]).toBe("Your visit");
    expect(terms).toContain("Hours on Tue 6 Oct");
    expect(terms).toContain("Booking");
    const visit = must(facts.querySelector('[data-fact="visit"] dd'), "the visit's times");
    expect(visit.querySelectorAll("time")).toHaveLength(2);
    expect(visit.querySelector("time")?.getAttribute("datetime")).toMatch(/^2026-10-06T\d\d:\d\d$/);
    expect(facts.textContent).toContain(`Level ${place.priceLevel} of 4 in the data`);
    // The listing's description is a quotation, captioned as the listing's own words.
    const listing = within(sheet()).getByTestId("stop-description");
    expect(listing.querySelector("figcaption")?.textContent).toBe(
      "The listing's description, in its own words",
    );
    expect(listing.querySelector("blockquote")?.textContent).toBe(place.description.trim());
    // Nothing opens inside the row.
    expect(within(rowElement(described)).queryByTestId("stop-details")).toBeNull();
  });

  it("opens from the stop's photo, with the photo large and its credit", async () => {
    const { user } = renderDay();
    const thumb = must(screen.queryAllByTestId("stop-thumb")[0], "a highlight photo");
    const row = must(thumb.closest<HTMLElement>("[data-testid='stop-row']"));
    const place = must(ctx.placesById.get(row.dataset.placeId ?? ""));
    expect(thumb.getAttribute("aria-label")).toBe(`Photo and details for ${place.name}`);
    await user.click(thumb);
    expect(sheet().open).toBe(true);
    expect(screen.getByTestId("details-title").textContent).toBe(place.name);
    const photo = must(sheet().querySelector(".place-photo--wide img"), "the large photo");
    expect(photo.getAttribute("alt")).toBe(photoForPlace(place)?.alt);
    expect(sheet().querySelector(".photo-credit")?.textContent).toContain("Wikimedia Commons");
  });

  it("closes with Escape and gives focus back to the Details button that opened it", async () => {
    const { user } = renderDay();
    const details = within(rowElement(described)).getByTestId("details-button");
    await user.click(details);
    expect(sheet().open).toBe(true);
    await user.keyboard("{Escape}");
    expect(sheet().open).toBe(false);
    expect(document.activeElement).toBe(details);
    expect(details.getAttribute("aria-expanded")).toBe("false");
    // The stop stays in the sheet while it leaves, so it never empties on its way out.
    expect(screen.getByTestId("details-title").textContent).toBe(described.place?.name);
  });

  it("closes with Escape and gives focus back to the photo that opened it", async () => {
    const { user } = renderDay();
    const thumb = must(screen.queryAllByTestId("stop-thumb")[0], "a highlight photo");
    await user.click(thumb);
    await user.keyboard("{Escape}");
    expect(sheet().open).toBe(false);
    expect(document.activeElement).toBe(thumb);
  });

  it("closes from its close pill and opens again on another stop", async () => {
    const { user } = renderDay();
    const [first, second] = view.rows;
    const firstDetails = within(rowElement(must(first))).getByTestId("details-button");
    await user.click(firstDetails);
    await user.click(screen.getByRole("button", { name: "Close details" }));
    expect(sheet().open).toBe(false);
    expect(document.activeElement).toBe(firstDetails);
    await user.click(within(rowElement(must(second))).getByTestId("details-button"));
    expect(sheet().open).toBe(true);
    expect(screen.getByTestId("details-title").textContent).toBe(second?.place?.name);
  });

  it("stays closed when its stop leaves the board and comes back", async () => {
    const user = userEvent.setup();
    const handlers = { onSwap: vi.fn(), onRemove: vi.fn(), onMove: vi.fn() };
    const day = (shown: typeof view) => (
      <DayTimetable view={shown} animate={false} changedStop={null} {...handlers} />
    );
    const { rerender } = render(day(view));
    await user.click(within(rowElement(described)).getByTestId("details-button"));
    expect(sheet().open).toBe(true);
    // An edit takes the stop off the board while its sheet is open, then another brings it back.
    rerender(day({ ...view, rows: view.rows.filter((row) => row !== described) }));
    expect(sheet().open).toBe(false);
    rerender(day(view));
    expect(sheet().open).toBe(false);
    expect(
      within(rowElement(described)).getByTestId("details-button").getAttribute("aria-expanded"),
    ).toBe("false");
  });

  it("closes when dragged down on a phone and gives focus back to what opened it", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(max-width: 767px)",
      media: query,
    }));
    try {
      const { user } = renderDay();
      const details = within(rowElement(described)).getByTestId("details-button");
      await user.click(details);
      const head = must(sheet().querySelector<HTMLElement>(".form-sheet-head"), "the sheet's head");
      const grab = { pointerId: 1, button: 0, clientX: 180, bubbles: true };
      fireEvent.pointerDown(head, { ...grab, clientY: 300 });
      fireEvent.pointerMove(head, { ...grab, clientY: 500 });
      expect(sheet().style.transform).toBe("translateY(200px)");
      fireEvent.pointerMove(head, { ...grab, clientY: 700 });
      fireEvent.pointerUp(head, { ...grab, clientY: 700 });
      expect(sheet().open).toBe(false);
      expect(sheet().style.transform).toBe("");
      expect(document.activeElement).toBe(details);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("stays open after a short drag on a phone, springing back", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(max-width: 767px)",
      media: query,
    }));
    try {
      const { user } = renderDay();
      await user.click(within(rowElement(described)).getByTestId("details-button"));
      const head = must(sheet().querySelector<HTMLElement>(".form-sheet-head"), "the sheet's head");
      Object.defineProperty(sheet(), "offsetHeight", { value: 600, configurable: true });
      const grab = { pointerId: 1, button: 0, clientX: 180, bubbles: true };
      // Less than a quarter of the sheet, and too short to count as a flick however fast.
      fireEvent.pointerDown(head, { ...grab, clientY: 300 });
      fireEvent.pointerMove(head, { ...grab, clientY: 320 });
      expect(sheet().dataset.dragging).toBe("true");
      fireEvent.pointerUp(head, { ...grab, clientY: 320 });
      expect(sheet().open).toBe(true);
      expect(sheet().style.transform).toBe("");
      expect(sheet().dataset.dragging).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("lists what the data cannot confirm under its own heading, with the listing's words quoted", () => {
    const trevi = must(ctx.placesById.get("place_018"));
    const first = must(view.rows[0]);
    const row: RowView = { ...first, place: trevi, stop: { ...first.stop, placeId: trevi.id } };
    render(
      <StopDetailsSheet
        id="details"
        open
        row={row}
        date={view.day.date}
        onClose={vi.fn()}
        returnFocus={{ current: null }}
      />,
    );
    const list = screen.getByRole("list", { name: "What the data cannot confirm" });
    expect(within(list).getAllByTestId("stop-caveat")[0]?.textContent).toContain(
      "planned between 07:00 and 23:00",
    );
  });

  it("names a stop whose place left the data, with nothing more to show", () => {
    const row: RowView = { ...must(view.rows[0]), place: undefined };
    render(
      <StopDetailsSheet
        id="details"
        open
        row={row}
        date={view.day.date}
        onClose={vi.fn()}
        returnFocus={{ current: null }}
      />,
    );
    expect(screen.getByTestId("details-title").textContent).toBe("A place no longer in the data");
    expect(screen.getByTestId("stop-details").children).toHaveLength(0);
  });
});
