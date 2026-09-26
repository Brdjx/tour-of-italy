import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ROUTE_LEDE, RouteSheet } from "../components/RouteSheet";
import { type DayChoices, dayChoices, type RouteView, routeView } from "../lib/dayRoute";
import type { RouteLevel } from "../lib/useDayRoute";
import { ctx, fixturePlan, must } from "./fixtures";

// The route sheet on its own (decision 16): its two levels, the day's cities with their facts, a
// refused city with its reason, the route with the change marked and its one action, and focus,
// Back and Escape moving between the levels. The page's side is in PlannerApp.route.test.tsx.

afterEach(cleanup);

/** Three days in Rome. */
const plan = fixturePlan();
const DATES = ["Tuesday 6 October", "Wednesday 7 October", "Thursday 8 October"];

interface Handlers {
  onChoose: (anchorId: string) => void;
  onIdeas: () => void;
  onReset: () => void;
  onConfirm: () => void;
  onClose: () => void;
}

/** The sheet with its levels driven as the page drives them, over `draft`. */
function Harness(props: { draft: string[]; start: RouteLevel; day: number } & Handlers) {
  const [level, setLevel] = useState<RouteLevel>(props.start);
  const [day, setDay] = useState(props.day);
  const [moved, setMoved] = useState(false);
  const view: RouteView = routeView(plan, props.draft, ctx);
  const choices: DayChoices = dayChoices(plan, props.draft, day, ctx);
  return (
    <RouteSheet
      open
      level={level}
      day={day}
      moved={moved}
      view={view}
      choices={choices}
      dates={DATES}
      range="Tue 6 Oct to Thu 8 Oct"
      said={{ text: null, serial: 0 }}
      onOpenDay={(next) => {
        setDay(next);
        setLevel("day");
        setMoved(true);
      }}
      onBack={() => {
        setLevel("route");
        setMoved(true);
      }}
      onChoose={props.onChoose}
      onIdeas={props.onIdeas}
      onReset={props.onReset}
      onConfirm={props.onConfirm}
      onClose={props.onClose}
      returnFocus={createRef()}
    />
  );
}

function renderSheet(draft: string[], start: RouteLevel = "day", day = 1) {
  const handlers: Handlers = {
    onChoose: vi.fn(),
    onIdeas: vi.fn(),
    onReset: vi.fn(),
    onConfirm: vi.fn(),
    onClose: vi.fn(),
  };
  render(<Harness draft={draft} start={start} day={day} {...handlers} />);
  return handlers;
}

describe("RouteSheet", () => {
  it("opens on a day's cities with the trip's city first, each other city with its facts", async () => {
    const { onChoose } = renderSheet(["rome", "rome", "rome"]);
    const sheet = await screen.findByTestId("route-sheet");
    const title = within(sheet).getByRole("heading", { name: "City for day 2" });
    expect(document.activeElement).toBe(title);
    expect(within(sheet).getByText("Wednesday 7 October")).toBeTruthy();
    const current = within(sheet).getByTestId("city-current");
    expect(current.textContent).toContain("Rome");
    expect(current.textContent).toContain("This day");
    const florence = within(sheet).getByRole("button", { name: "Florence" });
    const facts = document.getElementById(florence.getAttribute("aria-describedby") ?? "");
    expect(facts?.textContent).toContain("2 h 10 min by high-speed train from Rome");
    expect(facts?.textContent).toContain("Day 3 will be planned again");
    expect(florence.querySelector("svg.city-option-chevron")).not.toBeNull();
    await userEvent.setup().click(florence);
    expect(onChoose).toHaveBeenCalledWith("florence");
  });

  it("goes back to the route with Back and with Escape, and focus moves with it", async () => {
    const { onClose } = renderSheet(["rome", "rome", "rome"]);
    const user = userEvent.setup();
    const sheet = await screen.findByTestId("route-sheet");
    await user.click(within(sheet).getByRole("button", { name: "Back to your route" }));
    expect(within(sheet).getByRole("heading", { name: "Your route" })).toBeTruthy();
    // Focus is on the day the list was for.
    const second = within(sheet).getByRole("button", {
      name: "Day 2, Wed 7 Oct, Rome, choose city",
    });
    expect(document.activeElement).toBe(second);
    expect(within(sheet).getByText(ROUTE_LEDE)).toBeTruthy();
    // Another day's cities: focus goes to their heading.
    await user.click(
      within(sheet).getByRole("button", { name: "Day 3, Thu 8 Oct, Rome, choose city" }),
    );
    const third = within(sheet).getByRole("heading", { name: "City for day 3" });
    expect(document.activeElement).toBe(third);
    // Escape goes back one level, then closes.
    fireEvent.keyDown(third, { key: "Escape" });
    const row = within(sheet).getByRole("button", { name: "Day 3, Thu 8 Oct, Rome, choose city" });
    expect(document.activeElement).toBe(row);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(row, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows the route with the change marked, what it does, and its one action", async () => {
    const { onConfirm, onReset } = renderSheet(["rome", "florence", "rome"], "route");
    const sheet = await screen.findByTestId("route-sheet");
    const second = within(sheet).getByRole("button", {
      name: "Day 2, Wed 7 Oct, Florence, was Rome, choose city",
    });
    expect(second.dataset.changed).toBe("true");
    const facts = document.getElementById(second.getAttribute("aria-describedby") ?? "");
    expect(facts?.textContent).toContain("Day 2 will be planned in Florence.");
    expect(facts?.textContent).toContain("so the day starts at 11:40.");
    const third = within(sheet).getByRole("button", {
      name: "Day 3, Thu 8 Oct, Rome, choose city",
    });
    expect(third.dataset.replan).toBe("true");
    expect(third.textContent).toContain("Day 3 will be planned again");
    const legs = within(sheet)
      .getAllByTestId("route-leg")
      .map((leg) => leg.textContent);
    expect(legs).toEqual(["2 h 10 min by high-speed train", "2 h 10 min by high-speed train"]);
    expect(within(sheet).getByTestId("route-travel").textContent).toBe(
      "Travel between cities: 4 h 20 min",
    );
    const user = userEvent.setup();
    const reset = within(sheet).getByRole("button", { name: "Reset" });
    await user.click(within(sheet).getByRole("button", { name: "Plan day 2 and day 3" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    await user.click(reset);
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(within(sheet).getByRole("heading", { name: "Your route" }));
  });

  it("has no action before a change", async () => {
    renderSheet(["rome", "rome", "rome"], "route");
    const sheet = await screen.findByTestId("route-sheet");
    expect(within(sheet).queryByTestId("route-confirm")).toBeNull();
    expect(within(sheet).queryByTestId("route-travel")).toBeNull();
    expect(
      within(sheet)
        .getAllByTestId("route-leg")
        .map((leg) => leg.textContent),
    ).toEqual(["Same city", "Same city"]);
  });

  it("marks the city chosen for the day and the one it has now, and new ideas wait", async () => {
    const { onIdeas } = renderSheet(["rome", "florence", "rome"]);
    const sheet = await screen.findByTestId("route-sheet");
    const chosen = within(sheet).getByTestId("city-current");
    expect(chosen.dataset.anchorId).toBe("florence");
    expect(chosen.textContent).toContain("Chosen");
    const rome = within(sheet).getByRole("button", { name: "Rome" });
    expect(rome.textContent).toContain("Planned now");
    const ideas = within(sheet).getByRole("button", { name: "New ideas for this day" });
    expect(ideas.getAttribute("aria-disabled")).toBe("true");
    const reason = must(document.getElementById(ideas.getAttribute("aria-describedby") ?? ""));
    expect(reason.textContent).toBe("Your route has changes. Plan them or reset it first.");
    await userEvent.setup().click(ideas);
    expect(onIdeas).not.toHaveBeenCalled();
  });

  it("gives new ideas for the day while the route has no changes", async () => {
    const { onIdeas } = renderSheet(["rome", "rome", "rome"]);
    const sheet = await screen.findByTestId("route-sheet");
    await userEvent
      .setup()
      .click(within(sheet).getByRole("button", { name: "New ideas for this day" }));
    expect(onIdeas).toHaveBeenCalledTimes(1);
  });

  it("shows a city the day cannot take in place, with its reason and no chevron, and a press does nothing", async () => {
    const pinned = fixturePlan({ mustInclude: ["place_026"] });
    const onChoose = vi.fn();
    render(
      <RouteSheet
        open
        level="day"
        day={0}
        moved={false}
        view={routeView(pinned, ["florence", "rome", "rome"], ctx)}
        choices={dayChoices(pinned, ["florence", "rome", "rome"], 0, ctx)}
        dates={DATES}
        range=""
        said={{ text: "Day 1 set to Florence.", serial: 1 }}
        onOpenDay={vi.fn()}
        onBack={vi.fn()}
        onChoose={onChoose}
        onIdeas={vi.fn()}
        onReset={vi.fn()}
        onConfirm={vi.fn()}
        onClose={vi.fn()}
        returnFocus={createRef()}
      />,
    );
    const sheet = await screen.findByTestId("route-sheet");
    const rome = within(sheet).getByRole("button", { name: "Rome" });
    expect(rome.getAttribute("aria-disabled")).toBe("true");
    expect(rome.querySelector(".city-option-chevron")).toBeNull();
    const reason = document.getElementById(rome.getAttribute("aria-describedby") ?? "");
    expect(reason?.textContent).toContain("Keep day 1 in Florence, or remove Uffizi Gallery");
    await userEvent.setup().click(rome);
    expect(onChoose).not.toHaveBeenCalled();
    expect(within(sheet).getByTestId("route-said").textContent).toBe("Day 1 set to Florence.");
  });

  it("shows a refused route on its day, with the action dimmed", async () => {
    const pinned = fixturePlan({ mustInclude: ["place_026"] });
    const onConfirm = vi.fn();
    render(
      <RouteSheet
        open
        level="route"
        day={0}
        moved
        view={routeView(pinned, ["rome", "rome", "rome"], ctx)}
        choices={null}
        dates={DATES}
        range=""
        said={{ text: null, serial: 0 }}
        onOpenDay={vi.fn()}
        onBack={vi.fn()}
        onChoose={vi.fn()}
        onIdeas={vi.fn()}
        onReset={vi.fn()}
        onConfirm={onConfirm}
        onClose={vi.fn()}
        returnFocus={createRef()}
      />,
    );
    const sheet = await screen.findByTestId("route-sheet");
    expect(within(sheet).getByTestId("route-refusal").textContent).toContain(
      "Keep day 1 in Florence",
    );
    const action = within(sheet).getByTestId("route-confirm");
    expect(action.getAttribute("aria-disabled")).toBe("true");
    await userEvent.setup().click(action);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("keeps no content before it has a route, and closes from its close pill", async () => {
    const onClose = vi.fn();
    const props = {
      level: "route" as const,
      day: 0,
      moved: false,
      choices: null,
      dates: DATES,
      range: "",
      said: { text: null, serial: 0 },
      onOpenDay: vi.fn(),
      onBack: vi.fn(),
      onChoose: vi.fn(),
      onIdeas: vi.fn(),
      onReset: vi.fn(),
      onConfirm: vi.fn(),
      onClose,
      returnFocus: createRef<HTMLElement>(),
    };
    const { rerender } = render(<RouteSheet open view={null} {...props} />);
    const sheet = await screen.findByTestId("route-sheet");
    expect(within(sheet).queryByTestId("route-view")).toBeNull();
    await userEvent.setup().click(within(sheet).getByTestId("route-close"));
    expect(onClose).toHaveBeenCalledTimes(1);
    await act(async () => rerender(<RouteSheet open={false} view={null} {...props} />));
    expect(sheet.hasAttribute("open")).toBe(false);
  });
});
