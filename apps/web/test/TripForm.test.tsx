import type { TripRequest } from "@italy/planner";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { matchPlaces } from "../components/form/PlacePicker";
import { TripForm } from "../components/TripForm";
import { defaultFormValues, type TripFormValues } from "../lib/tripForm";
import { tripData, XSS } from "./fixtures";

// The form is the only way in. It must never send a request the API would refuse, must point
// at the field to fix, and must be usable by keyboard alone. Everything but the date and the
// pace sits behind "More options" (see TripForm.options.test.tsx for the fold itself).

afterEach(cleanup);

const options = tripData().options;

function renderForm(values: Partial<TripFormValues> = {}, planning = false) {
  const onSubmit = vi.fn<(request: TripRequest) => void>();
  const initialValues = { ...defaultFormValues(new Date(2026, 8, 23)), ...values };
  render(
    <TripForm
      options={options}
      initialValues={initialValues}
      planning={planning}
      onSubmit={onSubmit}
    />,
  );
  return { onSubmit, user: userEvent.setup() };
}

/** Opens "More options", where every field but the date and the pace lives. */
async function openOptions(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByTestId("more-options-button"));
}

describe("TripForm", () => {
  it("plans with the defaults in one tap and sends a schema-valid request", async () => {
    const { onSubmit, user } = renderForm();
    await user.click(screen.getByTestId("plan-button"));
    expect(onSubmit).toHaveBeenCalledWith({
      startDate: "2026-10-07",
      pace: "balanced",
      interests: [],
      maxPriceLevel: null,
      anchors: "auto",
      mustInclude: [],
      exclude: [],
    });
  });

  it("counts note characters and stops at 500", async () => {
    const { user } = renderForm();
    await openOptions(user);
    const notes = screen.getByLabelText("Anything else? Used by the AI planner.");
    await user.type(notes, "Slow mornings");
    expect(screen.getByTestId("notes-counter").textContent).toBe("13 of 500 characters");
    fireEvent.change(notes, { target: { value: "x".repeat(700) } });
    expect((notes as HTMLTextAreaElement).value).toHaveLength(500);
    expect(screen.getByTestId("notes-counter").textContent).toBe("500 of 500 characters");
    expect(notes.getAttribute("maxlength")).toBe("500");
  });

  it("keeps markup in notes as plain text and sends it as typed", async () => {
    const { onSubmit, user } = renderForm();
    await openOptions(user);
    const notes = screen.getByLabelText("Anything else? Used by the AI planner.");
    fireEvent.change(notes, { target: { value: XSS } });
    await user.click(screen.getByTestId("plan-button"));
    expect(document.querySelector("img")).toBeNull();
    expect(onSubmit.mock.calls[0]?.[0].notes).toBe(XSS);
  });

  it("stops on a bad date, says why, and focuses the date field", async () => {
    const { onSubmit, user } = renderForm({ startDate: "" });
    await user.click(screen.getByTestId("plan-button"));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText("Pick a start date.")).toBeTruthy();
    const date = screen.getByTestId("start-date");
    expect(document.activeElement).toBe(date);
    expect(date.getAttribute("aria-invalid")).toBe("true");
  });

  it("asks for a base when choosing bases and focuses the base choices", async () => {
    const { onSubmit, user } = renderForm();
    await openOptions(user);
    await user.click(screen.getByLabelText("Choose bases"));
    await user.click(screen.getByTestId("plan-button"));
    expect(onSubmit).not.toHaveBeenCalled();
    const error = screen.getByText("Pick at least one base, or let the planner choose.");
    // Focus lands on a base, not on the "Let the planner choose" radio, and the base announces
    // the error it is part of.
    const focused = document.activeElement as HTMLInputElement;
    expect(focused.type).toBe("checkbox");
    expect(focused.closest("[data-testid='anchors-field']")).toBeTruthy();
    expect(focused.getAttribute("aria-describedby")).toContain(error.id);
    expect(focused.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByTestId("anchors-field").hasAttribute("aria-invalid")).toBe(false);
    const bases = screen.getByTestId("anchors-field");
    await user.click(within(bases).getByLabelText(/^Rome/));
    await user.click(within(bases).getByLabelText(/^Florence/));
    const venice = within(bases).getByLabelText(/^Venice/) as HTMLInputElement;
    expect(venice.disabled).toBe(true);
    await user.click(screen.getByTestId("plan-button"));
    expect(onSubmit.mock.calls[0]?.[0].anchors).toEqual(["rome", "florence"]);
  });

  it("caps interests at 8 and disables the rest", async () => {
    const { onSubmit, user } = renderForm();
    await openOptions(user);
    await user.click(screen.getByTestId("show-all-interests"));
    const field = screen.getByTestId("interests-field");
    const boxes = within(field).getAllByRole("checkbox") as HTMLInputElement[];
    for (const box of boxes.slice(0, 8)) await user.click(box);
    expect(boxes[8]?.disabled).toBe(true);
    expect(field.textContent).toContain("You picked the most allowed (8).");
    await user.click(screen.getByTestId("plan-button"));
    expect(onSubmit.mock.calls[0]?.[0].interests).toHaveLength(8);
  });

  it("picks a must-see place with the keyboard only", async () => {
    const { onSubmit, user } = renderForm();
    await openOptions(user);
    const field = screen.getByTestId("must-see-field");
    const input = within(field).getByRole("combobox");
    await user.click(input);
    await user.keyboard("colos");
    expect(input.getAttribute("aria-expanded")).toBe("true");
    await user.keyboard("{ArrowDown}");
    const active = input.getAttribute("aria-activedescendant") as string;
    expect(document.getElementById(active)?.textContent).toContain("Colosseum");
    await user.keyboard("{Enter}");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(within(field).getByRole("button", { name: /Remove Colosseum/ })).toBeTruthy();
    expect((input as HTMLInputElement).value).toBe("");
    await user.click(screen.getByTestId("plan-button"));
    expect(onSubmit.mock.calls[0]?.[0].mustInclude).toHaveLength(1);
  });

  it("keeps focus in the picker when the last allowed place is picked", async () => {
    const { user } = renderForm();
    await openOptions(user);
    const field = screen.getByTestId("must-see-field");
    const input = within(field).getByRole("combobox") as HTMLInputElement;
    await user.click(input);
    for (let picked = 0; picked < options.limits.maxMustInclude; picked++) {
      await user.keyboard("a{ArrowDown}{Enter}");
    }
    expect(within(field).getAllByRole("button", { name: /^Remove / })).toHaveLength(
      options.limits.maxMustInclude,
    );
    expect(document.activeElement).toBe(input);
    expect(input.disabled).toBe(false);
    expect(input.readOnly).toBe(true);
    expect(input.getAttribute("aria-disabled")).toBe("true");
    expect(field.textContent).toContain("Remove one to add another");
    await user.keyboard("x");
    expect(input.value).toBe("");
  });

  it("scrolls a focused field out from under the sticky Plan my trip bar", async () => {
    const { user } = renderForm();
    await openOptions(user);
    const scrollBy = vi.fn();
    window.scrollBy = scrollBy as unknown as typeof window.scrollBy;
    const bar = document.querySelector(".form-actions") as HTMLElement;
    const notes = screen.getByLabelText("Anything else? Used by the AI planner.");
    const rect = (top: number, bottom: number) => ({ top, bottom }) as DOMRect;
    bar.getBoundingClientRect = () => rect(594, 667);
    notes.getBoundingClientRect = () => rect(539, 635);
    fireEvent.focus(notes);
    expect(scrollBy).toHaveBeenCalledWith({ top: 635 - 594 + 12 });
    scrollBy.mockClear();
    notes.getBoundingClientRect = () => rect(300, 396);
    fireEvent.focus(notes);
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it("closes the list on Escape, then clears the text on a second Escape", async () => {
    const { user } = renderForm();
    await openOptions(user);
    const input = within(screen.getByTestId("skip-field")).getByRole(
      "combobox",
    ) as HTMLInputElement;
    await user.click(input);
    await user.keyboard("rome");
    expect(input.getAttribute("aria-expanded")).toBe("true");
    await user.keyboard("{Escape}");
    expect(input.getAttribute("aria-expanded")).toBe("false");
    expect(input.value).toBe("rome");
    await user.keyboard("{Escape}");
    expect(input.value).toBe("");
  });

  it("never offers a must-see place in the skip list", () => {
    const hidden = new Set(["place_001"]);
    const found = matchPlaces(options.places, "a", hidden);
    expect(found.some((place) => place.id === "place_001")).toBe(false);
    expect(found.length).toBeLessThanOrEqual(8);
    expect(matchPlaces(options.places, "   ", new Set())).toEqual([]);
    expect(matchPlaces(options.places, "FLORENCE", new Set()).length).toBeGreaterThan(0);
  });

  it("says it is planning and ignores repeat taps while a plan is on its way", async () => {
    const { onSubmit, user } = renderForm({}, true);
    const button = screen.getByTestId("plan-button");
    expect(button.textContent).toBe("Planning your trip");
    expect(button.getAttribute("aria-disabled")).toBe("true");
    await user.click(button);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("sends the chosen pace and budget", async () => {
    const { onSubmit, user } = renderForm();
    await user.click(screen.getByLabelText("Packed"));
    expect(screen.getByTestId("pace-field").textContent).toContain(
      "Up to 7 visits a day, plus lunch and dinner, 08:30 to 23:30",
    );
    await openOptions(user);
    await user.click(screen.getByRole("radio", { name: "Up to price level 2, moderate" }));
    await user.click(screen.getByTestId("plan-button"));
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({ pace: "packed", maxPriceLevel: 2 });
  });
});
