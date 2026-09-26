import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CITY_SHEET_LEDE, DayCitySheet } from "../components/DayCitySheet";
import type { CityChoice } from "../lib/dayCity";

// The Change city sheet on its own: the day's city first with New ideas, every other city with
// its line, and a city the planner does not allow dimmed in place with its reason.

afterEach(cleanup);

const CHOICES: CityChoice[] = [
  {
    anchorId: "bologna",
    name: "Bologna",
    current: true,
    allowed: false,
    reason: "Nothing in Bologna fits day 1 with your settings.",
    line: "16 places",
  },
  {
    anchorId: "florence",
    name: "Florence",
    current: false,
    allowed: true,
    reason: null,
    line: "2 h 10 min by high-speed train from Rome, 22 places",
  },
];

function renderSheet(open = true, day: number | null = 0) {
  const onChoose = vi.fn();
  const onClose = vi.fn();
  render(
    <DayCitySheet
      open={open}
      day={day}
      date="Tuesday 6 October"
      choices={CHOICES}
      onChoose={onChoose}
      onClose={onClose}
      returnFocus={createRef()}
    />,
  );
  return { onChoose, onClose };
}

describe("DayCitySheet", () => {
  it("says why there are no new ideas, beside the button, and does nothing when pressed", async () => {
    const { onChoose } = renderSheet();
    const sheet = await screen.findByTestId("city-sheet");
    expect(within(sheet).getByText(CITY_SHEET_LEDE)).toBeTruthy();
    const ideas = within(sheet).getByRole("button", { name: "New ideas for this day" });
    expect(ideas.getAttribute("aria-disabled")).toBe("true");
    const reason = within(sheet).getByTestId("city-new-ideas-reason");
    expect(ideas.getAttribute("aria-describedby")).toBe(reason.id);
    expect(reason.textContent).toBe("Nothing in Bologna fits day 1 with your settings.");
    await userEvent.setup().click(ideas);
    expect(onChoose).not.toHaveBeenCalled();
  });

  it("chooses another city by its id, and names each by its city with its line as the description", async () => {
    const { onChoose } = renderSheet();
    const florence = await screen.findByRole("button", { name: "Florence" });
    expect(florence.getAttribute("aria-disabled")).toBeNull();
    const line = document.getElementById(florence.getAttribute("aria-describedby") ?? "");
    expect(line?.textContent).toBe("2 h 10 min by high-speed train from Rome, 22 places");
    // A city the day can take points onward, as the city pill does; the chevron is not named.
    expect(florence.querySelector("svg.city-option-chevron")?.getAttribute("aria-hidden")).toBe(
      "true",
    );
    await userEvent.setup().click(florence);
    expect(onChoose).toHaveBeenCalledWith("florence");
  });

  it("keeps no content once closed with no day, and closes from its close pill", async () => {
    const { onClose } = renderSheet(true);
    await userEvent.setup().click(await screen.findByTestId("city-close"));
    expect(onClose).toHaveBeenCalledTimes(1);
    cleanup();
    renderSheet(false, null);
    const sheet = await screen.findByTestId("city-sheet");
    expect(within(sheet).queryByTestId("city-choices")).toBeNull();
  });
});
