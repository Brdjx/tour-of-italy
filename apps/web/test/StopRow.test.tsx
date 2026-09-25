import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StopRow } from "../components/StopRow";
import { photoForPlace } from "../lib/placePhotos";
import { buildDayView, type RowView } from "../lib/timetable";
import { ctx, fixturePlan, must } from "./fixtures";

// One stop on the board: the meal it stands for leads the subtitle in place of a label above the
// name, the time column holds only times, the five actions share one line, and Details opens the
// facts for the stop's date with the listing's own words set apart from ours.

afterEach(cleanup);

const plan = fixturePlan();
const view = must(buildDayView(plan, 0, ctx, []));

function rowWhere(test: (row: RowView) => boolean): RowView {
  return must(view.rows.find(test), "matching row");
}

function renderRow(row: RowView, options: { thumbnail?: boolean } = {}) {
  const handlers = { onSwap: vi.fn(), onRemove: vi.fn(), onMove: vi.fn() };
  const utils = render(
    <ol>
      <StopRow
        row={row}
        dayIndex={0}
        date={view.day.date}
        isLast={row.index === view.rows.length - 1}
        dayStopCount={view.rows.length}
        changed={false}
        timesChanged={false}
        photo={row.place ? photoForPlace(row.place) : null}
        thumbnail={options.thumbnail ?? false}
        eagerPhoto={false}
        {...handlers}
      />
    </ol>,
  );
  return { ...utils, handlers, stop: screen.getByTestId("stop-row") };
}

describe("StopRow", () => {
  it("starts the subtitle with the meal instead of a label above the name", () => {
    const lunch = rowWhere((row) => row.stop.role === "lunch");
    const { stop } = renderRow(lunch);
    const label = within(stop).getByTestId("meal-label");
    expect(label.textContent).toBe("Lunch");
    const subtitle = must(label.parentElement);
    expect(subtitle.className).toContain("stop-subtitle");
    expect(subtitle.textContent).toMatch(/^Lunch, [a-z]+ in /);
    // The name is the first thing in the row's text: nothing sits above it.
    const heading = within(stop).getByRole("heading", { level: 3 });
    expect(heading.previousElementSibling).toBeNull();
  });

  it("keeps a plain visit's subtitle as it was", () => {
    const visit = rowWhere((row) => row.stop.role === "visit" && row.coveredMeals.length === 0);
    const { stop } = renderRow(visit);
    expect(within(stop).queryByTestId("meal-label")).toBeNull();
    expect(stop.querySelector(".stop-subtitle")?.textContent).toMatch(/^[A-Z][a-z ]+ in /);
  });

  it("holds only times in the time column and every action on one line", () => {
    const row = must(view.rows[1]);
    const { stop } = renderRow(row);
    const gutter = must(stop.querySelector(".stop-gutter"));
    expect(gutter.querySelectorAll("button")).toHaveLength(0);
    expect(gutter.querySelectorAll("time")).toHaveLength(2);
    const line = must(stop.querySelector<HTMLElement>(".stop-controls"));
    const ids = [...line.querySelectorAll("button")].map((button) => button.dataset.testid);
    expect(ids).toEqual(["details-button", "swap-button", "remove-button", "move-up", "move-down"]);
    const name = row.place?.name ?? "";
    // Swap and Remove keep their word for wider screens; the name says it at every width.
    const swap = within(line).getByRole("button", { name: `Swap ${name}` });
    expect(swap.querySelector(".stop-action-label")?.textContent).toBe("Swap");
    expect(within(line).getByRole("button", { name: `Remove ${name}` })).toBeTruthy();
    expect(within(line).getByRole("button", { name: `Move ${name} up` })).toBeTruthy();
  });

  it("shows the small photo only on a highlight stop with a photo of its own", () => {
    const own = rowWhere(
      (row) => row.place !== undefined && photoForPlace(row.place)?.kind === "place",
    );
    renderRow(own, { thumbnail: true });
    expect(screen.getByTestId("stop-thumb")).toBeTruthy();
    cleanup();
    renderRow(own, { thumbnail: false });
    expect(screen.queryByTestId("stop-thumb")).toBeNull();
    expect(screen.getByTestId("details-button")).toBeTruthy();
  });

  it("opens the facts for the stop's date, what the data cannot confirm, and the listing's words", async () => {
    const user = userEvent.setup();
    const row = rowWhere((row) => (row.place?.description.trim() ?? "") !== "");
    const place = must(row.place);
    const { stop } = renderRow(row);
    const toggle = within(stop).getByTestId("details-button");
    expect(within(stop).queryByTestId("stop-details")).toBeNull();
    await user.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const details = within(stop).getByTestId("stop-details");
    const sheet = within(details).getByTestId("stop-fact-sheet");
    expect(within(sheet).getByText("Hours on Tue 6 Oct")).toBeTruthy();
    expect(within(sheet).getByText("Booking")).toBeTruthy();
    expect(sheet.textContent).toContain(`Level ${place.priceLevel} of 4 in the data`);
    // The listing's description is a quotation, captioned as the listing's own words.
    const listing = within(details).getByTestId("stop-description");
    expect(listing.querySelector("figcaption")?.textContent).toBe(
      "The listing's description, in its own words",
    );
    expect(listing.querySelector("blockquote")?.textContent).toBe(place.description.trim());
    await user.click(toggle);
    expect(within(stop).queryByTestId("stop-details")).toBeNull();
  });

  it("lists what the data cannot confirm under its own heading, with the listing's words quoted", async () => {
    const user = userEvent.setup();
    const trevi = must(ctx.placesById.get("place_018"));
    const row = {
      ...must(view.rows[0]),
      place: trevi,
      stop: { ...must(view.rows[0]).stop, placeId: trevi.id },
    };
    const { stop } = renderRow(row);
    await user.click(within(stop).getByTestId("details-button"));
    const section = within(stop).getByRole("list", { name: "What the data cannot confirm" });
    expect(within(section).getAllByTestId("stop-caveat")[0]?.textContent).toContain(
      "planned between 07:00 and 23:00",
    );
  });

  it("opens from the thumbnail, which then gives way to the wide photo", async () => {
    const user = userEvent.setup();
    const own = rowWhere(
      (row) => row.place !== undefined && photoForPlace(row.place)?.kind === "place",
    );
    const { stop } = renderRow(own, { thumbnail: true });
    await user.click(within(stop).getByTestId("stop-thumb"));
    expect(within(stop).getByTestId("stop-details")).toBeTruthy();
    expect(within(stop).queryByTestId("stop-thumb")).toBeNull();
  });
});
