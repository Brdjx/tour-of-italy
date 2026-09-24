import { buildPlannerContext, type Itinerary, planDeterministic } from "@italy/planner";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DayTabs } from "../components/DayTabs";
import { DayTimetable } from "../components/DayTimetable";
import { buildDayView, buildTripView } from "../lib/timetable";
import { ctx, fixturePlan, GENERATED_AT, makeRequest, places, vaticanDay, XSS } from "./fixtures";

// The timetable is the product: it must list every stop in order with machine-readable times,
// and render anything from the data or the AI as inert text.

afterEach(cleanup);

const noop = () => {};

function renderDay(plan: Itinerary, day = 0, context = ctx) {
  const view = buildDayView(plan, day, context, []);
  if (!view) throw new Error("no view");
  const handlers = { onSwap: vi.fn(), onRemove: vi.fn(), onMove: vi.fn() };
  const utils = render(
    <DayTimetable view={view} animate={false} changedStop={null} {...handlers} />,
  );
  return { ...utils, view, handlers };
}

describe("DayTimetable", () => {
  it("renders every stop as an ordered list item, in visiting order, with <time> elements", () => {
    const plan = fixturePlan();
    const { container, view } = renderDay(plan);
    const list = screen.getByRole("list", { name: "Stops in visiting order" });
    expect(list.tagName).toBe("OL");
    const rows = within(list).getAllByTestId("stop-row");
    expect(rows.map((row) => row.dataset.placeId)).toEqual(
      plan.days[0]?.stops.map((stop) => stop.placeId),
    );
    const times = container.querySelectorAll("time");
    expect(times).toHaveLength(view.rows.length * 2);
    expect(times[0]?.getAttribute("datetime")).toMatch(/^2026-10-06T\d\d:\d\d$/);
    expect(screen.getByRole("heading", { level: 2, name: "Tuesday 6 October" })).toBeTruthy();
    expect(screen.getByText(/Day 1 in Rome/)).toBeTruthy();
  });

  it("labels meals and shows a travel leg before every stop", () => {
    const plan = fixturePlan();
    renderDay(plan);
    const roles = plan.days[0]?.stops.map((stop) => stop.role) ?? [];
    expect(screen.queryAllByText("Lunch")).toHaveLength(
      roles.filter((role) => role === "lunch").length,
    );
    expect(screen.getAllByTestId("travel-leg")).toHaveLength(roles.length);
  });

  it("says lunch happens during a long visit, where the meal label would be", () => {
    const plan = fixturePlan({ pace: "relaxed", interests: [], anchors: ["rome"] });
    renderDay(plan, vaticanDay(plan));
    const vatican = screen
      .getAllByTestId("stop-row")
      .find((row) => row.textContent?.includes("Vatican Museums")) as HTMLElement;
    expect(within(vatican).getByTestId("meal-label").textContent).toBe("Lunch during this visit");
    // The rule sentence saying the same thing is not repeated under it.
    expect(vatican.textContent).not.toContain("Lunch is part of this outing.");
  });

  it("counts visits in the day header, the unit the pace limit uses", () => {
    const { view } = renderDay(fixturePlan());
    expect(screen.getByRole("heading", { level: 2 }).parentElement?.textContent).toContain(
      `in ${view.anchorName}, ${view.stopsText}`,
    );
    expect(view.stopsText).toMatch(/^\d+ visits?/);
  });

  it("shows the move from the previous base as a timed first row", () => {
    const plan = fixturePlan({ anchors: ["rome", "florence"] });
    const index = plan.days.findIndex((day) => day.transferMin > 0);
    const { view } = renderDay(plan, index);
    const row = screen.getByTestId("transfer-note");
    const times = row.querySelectorAll("time");
    expect(times).toHaveLength(2);
    expect(times[0]?.textContent).toMatch(/^\d{2}:\d{2}$/);
    expect(row.textContent).toContain(`from ${view.transfer?.text.split(" from ")[1]}`);
    expect(row.compareDocumentPosition(screen.getAllByTestId("stop-row")[0] as Node)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("marks AI reasons apart from rule reasons for screen readers", () => {
    const plan = fixturePlan();
    const day = plan.days[0];
    if (!day) throw new Error("no day");
    const mixed: Itinerary = {
      ...plan,
      days: [
        {
          ...day,
          stops: day.stops.map((stop, index) =>
            index === 0 ? { ...stop, reason: "Chosen by the model.", reasonSource: "ai" } : stop,
          ),
        },
        ...plan.days.slice(1),
      ],
    };
    renderDay(mixed);
    const reasons = screen.getAllByTestId("stop-reason");
    expect(reasons[0]?.textContent).toContain("Why, from the AI planner: Chosen by the model.");
    expect(reasons[1]?.textContent).toContain("Why, from the rules:");
  });

  it("renders a hostile place name and reason as text, never as HTML", () => {
    const hostile = places.map((place) =>
      place.id === "place_001" ? { ...place, name: XSS } : place,
    );
    const context = buildPlannerContext(hostile);
    const plan = planDeterministic(makeRequest({ mustInclude: ["place_001"] }), context, {
      generatedAt: GENERATED_AT,
    });
    const dayIndex = plan.days.findIndex((day) => day.stops.some((s) => s.placeId === "place_001"));
    const day = plan.days[dayIndex];
    if (!day) throw new Error("must-include not placed");
    const withReason: Itinerary = {
      ...plan,
      days: plan.days.map((d, index) =>
        index === dayIndex
          ? {
              ...d,
              stops: d.stops.map((s) => ({ ...s, reason: XSS, reasonSource: "ai" as const })),
            }
          : d,
      ),
    };
    const { container } = renderDay(withReason, dayIndex, context);
    // The only images are our own place photos; the markup in the name and reason never
    // becomes an element.
    for (const image of container.querySelectorAll("img")) {
      expect(image.classList.contains("place-photo-img"), image.outerHTML).toBe(true);
      expect(image.hasAttribute("onerror")).toBe(false);
      expect(image.getAttribute("src")?.startsWith("/photos/")).toBe(true);
    }
    expect(screen.getByRole("heading", { level: 3, name: XSS })).toBeTruthy();
    expect((window as { __xss?: number }).__xss).toBeUndefined();
  });

  it("wires each row's actions to its own index and keeps edge moves inert", async () => {
    const user = userEvent.setup();
    const { handlers, view } = renderDay(fixturePlan());
    const rows = screen.getAllByTestId("stop-row");
    await user.click(within(rows[1] as HTMLElement).getByTestId("swap-button"));
    expect(handlers.onSwap).toHaveBeenCalledWith(1);
    await user.click(within(rows[0] as HTMLElement).getByTestId("remove-button"));
    expect(handlers.onRemove).toHaveBeenCalledWith(0);
    await user.click(within(rows[0] as HTMLElement).getByTestId("move-down"));
    expect(handlers.onMove).toHaveBeenCalledWith(0, "down");
    const firstUp = within(rows[0] as HTMLElement).getByTestId("move-up");
    expect(firstUp.getAttribute("aria-disabled")).toBe("true");
    await user.click(firstUp);
    expect(handlers.onMove).toHaveBeenCalledTimes(1);
    const lastDown = within(rows[view.rows.length - 1] as HTMLElement).getByTestId("move-down");
    expect(lastDown.getAttribute("aria-disabled")).toBe("true");
  });

  it("reaches every action by keyboard with a name that says which stop it changes", async () => {
    const user = userEvent.setup();
    const { view } = renderDay(fixturePlan());
    const name = view.rows[0]?.place?.name ?? "";
    const group = screen.getAllByTestId("stop-actions")[0] as HTMLElement;
    expect(within(group).getByRole("button", { name: `Swap ${name}` })).toBeTruthy();
    const moves = screen.getAllByTestId("stop-moves")[0] as HTMLElement;
    expect(within(moves).getByRole("button", { name: `Move ${name} up` })).toBeTruthy();
    await user.tab();
    const focused = document.activeElement;
    expect(focused?.closest("[data-testid='stop-row']")).toBeTruthy();
  });

  it("marks a flagged stop for sighted and screen reader users", () => {
    const plan = fixturePlan();
    const view = buildDayView(plan, 0, ctx, [
      {
        code: "CLOSED_AT_TIME",
        severity: "error",
        day: 0,
        stopIndex: 0,
        detail: "Closed at 09:45.",
      },
    ]);
    if (!view) throw new Error("no view");
    render(
      <DayTimetable
        view={view}
        animate
        changedStop={0}
        onSwap={noop}
        onRemove={noop}
        onMove={noop}
      />,
    );
    const row = screen.getAllByTestId("stop-row")[0] as HTMLElement;
    expect(row.dataset.flagged).toBe("true");
    expect(row.className).toContain("stop-row--changed");
    expect(within(row).getByText("Problem:", { exact: false })).toBeTruthy();
    expect(screen.getByRole("list", { name: "Stops in visiting order" }).className).toContain(
      "timetable--draw",
    );
  });
});

describe("DayTabs", () => {
  it("moves between days with arrow keys, Home and End, one tab stop in total", async () => {
    const user = userEvent.setup();
    const days = buildTripView(fixturePlan(), ctx, []);
    const onSelect = vi.fn();
    const { rerender } = render(<DayTabs days={days} active={0} onSelect={onSelect} />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.getAttribute("tabindex"))).toEqual(["0", "-1", "-1"]);
    expect(screen.getByTestId("day-tab-1").getAttribute("aria-selected")).toBe("true");
    tabs[0]?.focus();
    await user.keyboard("{ArrowRight}");
    expect(onSelect).toHaveBeenLastCalledWith(1);
    await user.keyboard("{ArrowLeft}");
    expect(onSelect).toHaveBeenLastCalledWith(0);
    await user.keyboard("{ArrowLeft}");
    expect(onSelect).toHaveBeenLastCalledWith(2);
    await user.keyboard("{Home}");
    expect(onSelect).toHaveBeenLastCalledWith(0);
    await user.keyboard("{End}");
    expect(onSelect).toHaveBeenLastCalledWith(2);
    rerender(<DayTabs days={days} active={2} onSelect={onSelect} />);
    await user.click(screen.getByTestId("day-tab-2"));
    expect(onSelect).toHaveBeenLastCalledWith(1);
  });

  it("names each day's base on narrow tabs when the trip has two bases", () => {
    const twoBases = buildTripView(fixturePlan({ anchors: ["rome", "venice"] }), ctx, []);
    const { rerender } = render(<DayTabs days={twoBases} active={0} onSelect={() => {}} />);
    expect(screen.getByTestId("day-tabs").dataset.multiBase).toBe("true");
    const cities = [...document.querySelectorAll(".day-tab-city")].map((node) => node.textContent);
    expect(cities).toEqual(twoBases.map((day) => `, ${day.anchorName}`));
    const oneBase = buildTripView(fixturePlan(), ctx, []);
    rerender(<DayTabs days={oneBase} active={0} onSelect={() => {}} />);
    expect(screen.getByTestId("day-tabs").dataset.multiBase).toBeUndefined();
  });
});
