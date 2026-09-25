import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StopRow } from "../components/StopRow";
import { photoForPlace } from "../lib/placePhotos";
import { buildDayView, type RowView } from "../lib/timetable";
import { ctx, fixturePlan, must } from "./fixtures";

// One stop on the board: the meal it stands for leads the subtitle in place of a label above the
// name, the time column holds only times, the five actions share one line, and the photo and
// Details hand the stop to the details sheet (StopDetailsSheet.test.tsx) instead of opening it
// in the row.

afterEach(cleanup);

const plan = fixturePlan();
const view = must(buildDayView(plan, 0, ctx, []));

function rowWhere(test: (row: RowView) => boolean): RowView {
  return must(view.rows.find(test), "matching row");
}

const DETAILS_ID = "details-sheet-id";

function renderRow(row: RowView, options: { thumbnail?: boolean; detailsOpen?: boolean } = {}) {
  const handlers = {
    onSwap: vi.fn(),
    onRemove: vi.fn(),
    onMove: vi.fn(),
    onDetails: vi.fn<(opener: HTMLElement) => void>(),
  };
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
        detailsId={DETAILS_ID}
        detailsOpen={options.detailsOpen ?? false}
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

  it("hands the stop to the details sheet from Details, with nothing opening in the row", async () => {
    const user = userEvent.setup();
    const row = must(view.rows[1]);
    const { stop, handlers } = renderRow(row);
    const name = row.place?.name ?? "";
    const details = within(stop).getByRole("button", { name: `Details for ${name}` });
    expect(details).toBe(within(stop).getByTestId("details-button"));
    expect(details.getAttribute("aria-haspopup")).toBe("dialog");
    expect(details.getAttribute("aria-controls")).toBe(DETAILS_ID);
    expect(details.getAttribute("aria-expanded")).toBe("false");
    await user.click(details);
    expect(handlers.onDetails).toHaveBeenCalledWith(details);
    expect(within(stop).queryByTestId("stop-details")).toBeNull();
  });

  it("makes the thumbnail a button that opens the photo and details", async () => {
    const user = userEvent.setup();
    const own = rowWhere(
      (row) => row.place !== undefined && photoForPlace(row.place)?.kind === "place",
    );
    const { stop, handlers } = renderRow(own, { thumbnail: true });
    const thumb = within(stop).getByRole("button", {
      name: `Photo and details for ${own.place?.name}`,
    });
    expect(thumb).toBe(within(stop).getByTestId("stop-thumb"));
    expect(thumb.getAttribute("aria-haspopup")).toBe("dialog");
    expect(thumb.getAttribute("aria-controls")).toBe(DETAILS_ID);
    await user.click(thumb);
    expect(handlers.onDetails).toHaveBeenCalledWith(thumb);
    // The small photo stays on the row; the large one is in the sheet.
    expect(within(stop).getByTestId("stop-thumb")).toBe(thumb);
    expect(stop.querySelector(".place-photo--wide")).toBeNull();
  });

  it("says the sheet is open on this stop on both of its openers", () => {
    const own = rowWhere(
      (row) => row.place !== undefined && photoForPlace(row.place)?.kind === "place",
    );
    const { stop } = renderRow(own, { thumbnail: true, detailsOpen: true });
    expect(within(stop).getByTestId("stop-thumb").getAttribute("aria-expanded")).toBe("true");
    expect(within(stop).getByTestId("details-button").getAttribute("aria-expanded")).toBe("true");
  });
});
