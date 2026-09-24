import type { TripRequest } from "@italy/planner";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OPTIONS_FAILED } from "../components/form/MoreOptions";
import type { DataStatus } from "../components/form/OptionFields";
import { TripForm } from "../components/TripForm";
import { INTERESTS_SHOWN } from "../lib/moreOptions";
import { defaultFormValues, type TripFormValues } from "../lib/tripForm";
import { tripData } from "./fixtures";

// "More options": the filters stay folded until asked for, the button says how many are set,
// the fold works by keyboard, Clear options resets only the options, an error inside the fold
// opens it, and the form works (date, pace, Plan my trip) before the places arrive or when they
// cannot load.

afterEach(cleanup);

const options = tripData().options;

function renderForm(
  props: { values?: Partial<TripFormValues>; status?: DataStatus; withOptions?: boolean } = {},
) {
  const onSubmit = vi.fn<(request: TripRequest) => void>();
  const onRetryData = vi.fn();
  const initialValues = { ...defaultFormValues(new Date(2026, 8, 23)), ...props.values };
  const view = render(
    <TripForm
      options={props.withOptions === false ? null : options}
      dataStatus={props.status}
      onRetryData={onRetryData}
      initialValues={initialValues}
      planning={false}
      onSubmit={onSubmit}
    />,
  );
  return { onSubmit, onRetryData, view, user: userEvent.setup() };
}

const button = () => screen.getByTestId("more-options-button");
const panel = () => screen.getByTestId("more-options-panel");
const folded = () => panel().hidden;

describe("More options", () => {
  it("keeps every filter out of sight until More options is opened", () => {
    renderForm();
    expect(button().getAttribute("aria-expanded")).toBe("false");
    expect(button().getAttribute("aria-controls")).toBe(panel().id);
    expect(folded()).toBe(true);
    // Only the date, the pace and the plan button are reachable.
    expect(screen.queryByRole("group", { name: "Interests" })).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByTestId("start-date")).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Balanced" })).toBeTruthy();
    expect(screen.getByTestId("plan-button").textContent).toBe("Plan my trip");
    expect(screen.queryByTestId("options-count")).toBeNull();
  });

  it("opens and closes with the keyboard and reports it through aria-expanded", async () => {
    const { user } = renderForm();
    button().focus();
    await user.keyboard("{Enter}");
    expect(button().getAttribute("aria-expanded")).toBe("true");
    expect(folded()).toBe(false);
    expect(screen.getByRole("group", { name: /Interests/ })).toBeTruthy();
    await user.keyboard(" ");
    expect(button().getAttribute("aria-expanded")).toBe("false");
    expect(folded()).toBe(true);
    expect(document.activeElement).toBe(button());
  });

  it("counts set options by group on the button and in its accessible name", async () => {
    const { user } = renderForm();
    await user.click(button());
    const interests = within(screen.getByTestId("interests-field")).getAllByRole("checkbox");
    await user.click(interests[0] as HTMLElement);
    await user.click(interests[1] as HTMLElement);
    expect(screen.getByTestId("options-count").textContent).toBe("1 set");
    expect(button().getAttribute("aria-label")).toBe("More options, 1 set");
    await user.click(screen.getByRole("radio", { name: "Up to price level 2, moderate" }));
    expect(screen.getByRole("button", { name: "More options, 2 set" })).toBe(button());
    await user.click(button());
    // Folded, the badge still says what is set.
    expect(screen.getByTestId("options-count").textContent).toContain("2 set");
  });

  it("clears every option, keeps the date and pace, and returns focus to More options", async () => {
    const { onSubmit, user } = renderForm();
    await user.click(screen.getByRole("radio", { name: "Packed" }));
    await user.click(button());
    const interests = within(screen.getByTestId("interests-field")).getAllByRole("checkbox");
    await user.click(interests[0] as HTMLElement);
    await user.click(screen.getByRole("radio", { name: "Up to price level 1, inexpensive" }));
    await user.click(screen.getByLabelText("Choose bases"));
    fireEvent.change(screen.getByLabelText("Anything else? Used by the AI planner."), {
      target: { value: "Slow mornings" },
    });
    expect(screen.getByTestId("options-count").textContent).toContain("4 set");
    await user.click(screen.getByTestId("clear-options"));
    expect(screen.queryByTestId("options-count")).toBeNull();
    expect(screen.queryByTestId("clear-options")).toBeNull();
    expect(document.activeElement).toBe(button());
    await user.click(screen.getByTestId("plan-button"));
    expect(onSubmit).toHaveBeenCalledWith({
      startDate: "2026-10-07",
      pace: "packed",
      interests: [],
      maxPriceLevel: null,
      anchors: "auto",
      mustInclude: [],
      exclude: [],
    });
  });

  it("opens the fold and focuses the field when the error is inside it", async () => {
    const { onSubmit, user } = renderForm({ values: { anchorMode: "choose" } });
    expect(folded()).toBe(true);
    await user.click(screen.getByTestId("plan-button"));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(folded()).toBe(false);
    const focused = document.activeElement as HTMLInputElement;
    expect(focused.type).toBe("checkbox");
    expect(focused.closest("[data-testid='anchors-field']")).toBeTruthy();
  });

  it("shows the most common interests first, keeps a picked one in view, and shows all on request", async () => {
    const picked = options.interests.at(-1)?.tag ?? "";
    const { user } = renderForm({ values: { interests: [picked] } });
    await user.click(button());
    const field = screen.getByTestId("interests-field");
    const shown = () => within(field).getAllByRole("checkbox") as HTMLInputElement[];
    const counts = options.interests.map((item) => item.count).sort((a, b) => b - a);
    expect(shown()).toHaveLength(INTERESTS_SHOWN + 1);
    expect(
      shown()
        .slice(0, INTERESTS_SHOWN)
        .map((box) => box.value),
    ).toEqual(options.interests.slice(0, INTERESTS_SHOWN).map((item) => item.tag));
    expect(shown().at(-1)?.value).toBe(picked);
    expect(shown().at(-1)?.checked).toBe(true);
    const more = screen.getByTestId("show-all-interests");
    expect(more.getAttribute("aria-expanded")).toBe("false");
    await user.click(more);
    expect(shown()).toHaveLength(counts.length);
    expect(more.textContent).toBe("Show fewer interests");
  });
});

describe("the form before and without the places", () => {
  it("plans with the date and pace while the options still show skeletons", async () => {
    const { onSubmit, user } = renderForm({ withOptions: false });
    await user.click(button());
    expect(panel().getAttribute("aria-busy")).toBe("true");
    expect(screen.getByTestId("interests-skeleton").getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByTestId("must-see-field-skeleton")).toBeTruthy();
    expect(screen.getByTestId("skip-field-skeleton")).toBeTruthy();
    await user.click(screen.getByLabelText("Choose bases"));
    expect(screen.getByTestId("anchors-skeleton")).toBeTruthy();
    await user.click(screen.getByLabelText("Let the planner choose"));
    await user.click(screen.getByRole("radio", { name: "Relaxed" }));
    await user.click(screen.getByTestId("plan-button"));
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({ pace: "relaxed", anchors: "auto" });
  });

  it("leaves no skeleton behind once the options arrive", async () => {
    const { view, user } = renderForm({ withOptions: false });
    await user.click(button());
    expect(view.container.querySelectorAll(".skeleton").length).toBeGreaterThan(0);
    view.rerender(
      <TripForm
        options={options}
        initialValues={defaultFormValues(new Date(2026, 8, 23))}
        planning={false}
        onSubmit={() => {}}
      />,
    );
    expect(view.container.querySelectorAll(".skeleton")).toHaveLength(0);
    expect(panel().hasAttribute("aria-busy")).toBe(false);
    expect(within(screen.getByTestId("interests-field")).getAllByRole("checkbox")).toHaveLength(
      INTERESTS_SHOWN,
    );
  });

  it("says the options could not load, offers Try again, and still plans", async () => {
    const { onSubmit, onRetryData, user } = renderForm({ withOptions: false, status: "error" });
    // Visible while folded, so the traveler learns it without opening anything.
    expect(folded()).toBe(true);
    expect(screen.getByTestId("options-error").textContent).toContain(OPTIONS_FAILED);
    expect(screen.getByRole("alert")).toBe(screen.getByTestId("options-error"));
    await user.click(screen.getByTestId("options-retry"));
    expect(onRetryData).toHaveBeenCalledOnce();
    await user.click(button());
    // Budget and notes need no data and stay; the place-based fields are left out, not faked.
    expect(screen.getByTestId("budget-field")).toBeTruthy();
    expect(screen.getByTestId("notes-field")).toBeTruthy();
    expect(screen.queryByTestId("interests-field")).toBeNull();
    expect(screen.queryByTestId("must-see-field")).toBeNull();
    expect(document.querySelectorAll(".skeleton")).toHaveLength(0);
    await user.click(screen.getByTestId("plan-button"));
    expect(onSubmit).toHaveBeenCalledOnce();
  });
});
