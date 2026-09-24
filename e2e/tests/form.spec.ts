import { DEFAULT_START_DATE } from "../support/env";
import { expect, test } from "../support/fixtures";
import { openPlanner, placeIds, planTrip, readTrip, reopenForm } from "../support/plan";

// The trip form and the other parts of the page around the plan: inline checks that stop a bad
// request before it leaves, choices that actually reach the plan, the data notes, and the 404.

test.describe("the trip form", () => {
  test("starts on the date two weeks after today, so one press plans a trip", async ({ page }) => {
    await openPlanner(page);
    await expect(page.getByTestId("start-date")).toHaveValue(DEFAULT_START_DATE);
  });

  test("shows the problem next to the field and focuses it instead of sending a bad request", async ({
    page,
    press,
  }) => {
    const planRequests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/plan")) planRequests.push(request.url());
    });
    await openPlanner(page);
    await press(page.getByTestId("anchor-mode-field").getByText("Choose bases"));
    await press(page.getByTestId("plan-button"));

    const bases = page.getByTestId("anchors-field");
    await expect(bases).toContainText("Pick at least one base, or let the planner choose.");
    await expect(bases.locator("input").first()).toBeFocused();

    await page.getByTestId("start-date").fill("");
    await press(page.getByTestId("plan-button"));
    await expect(page.locator('[data-field="startDate"]')).toContainText("Pick a start date.");
    await expect(page.getByTestId("start-date")).toBeFocused();
    expect(planRequests, "a plan request left with a form error").toEqual([]);
  });

  test("plans every day in the one base the traveler chose", async ({ page, press }) => {
    await openPlanner(page);
    await press(page.getByTestId("anchor-mode-field").getByText("Choose bases"));
    const florence = page.getByTestId("anchors-field").getByText("Florence", { exact: false });
    await press(florence.first());
    await planTrip(page, press);

    const timetable = page.getByTestId("day-timetable");
    for (let day = 1; day <= 3; day++) {
      await press(page.getByTestId(`day-tab-${day}`));
      await expect(timetable).toContainText(`Day ${day} in Florence`);
    }
  });

  test("never plans a place the traveler asked to skip", async ({ page, press, twoPane }) => {
    await openPlanner(page);
    await planTrip(page, press);
    const first = await readTrip(page, press);
    const skipped = first[0]?.[0]?.placeId ?? "";
    await press(page.getByTestId("day-tab-1"));
    const skippedName = (await page.locator(`[data-place-id="${skipped}"] h3`).innerText()).trim();
    await reopenForm(page, press, twoPane);
    const skip = page.getByTestId("skip-field");
    await skip.getByRole("combobox").fill(skippedName.slice(0, 12));
    await press(skip.getByRole("option", { name: skippedName }).first());
    await planTrip(page, press);

    const again = await readTrip(page, press);
    expect(again.flatMap(placeIds)).not.toContain(skipped);
  });
});

test.describe("around the plan", () => {
  test("the data notes open and explain how the data was cleaned", async ({ page, press }) => {
    await openPlanner(page);
    const notes = page.getByTestId("data-notes");
    await expect(page.getByTestId("data-headline")).not.toBeEmpty();
    await press(notes.locator("summary"));
    await expect(notes).toHaveAttribute("open", "");
    await expect(notes.locator("li").first()).toBeVisible();
    await expect(notes).toContainText(/\(\d+ places?\)/);
  });

  test("an unknown address shows the app's own 404 page with a way back", async ({
    page,
    press,
  }) => {
    const response = await page.goto("/no-such-page/");
    expect(response?.status()).toBe(404);
    const home = page.getByTestId("not-found-home");
    await expect(home).toBeVisible();
    await press(home);
    await expect(page.getByTestId("plan-button")).toBeVisible();
  });
});
