import { DEFAULT_START_DATE } from "../support/env";
import { expect, test } from "../support/fixtures";
import {
  BADGE,
  badgeDetails,
  expectTimesInOrder,
  openPlanner,
  placeFromAnotherBase,
  placeIds,
  plansAnnounced,
  planTrip,
  readDay,
  readStops,
  readTrip,
  reopenForm,
} from "../support/plan";

// When the planner service fails, the traveler still gets a plan (built on the device with the
// same rules) labelled with the real cause, or a clear error with the previous plan kept.
// "Offline" is only ever claimed when the request never reached the server.

const PLAN_ROUTE = "**/api/plan*";

/** The API's own deadline for a plan (PLAN_DEADLINE_MS in playwright.config.ts). */
const API_DEADLINE_MS = 24_000;
/** The page's deadline for a plan request (TIMEOUTS.plan in apps/web/lib/api.ts). */
const CLIENT_DEADLINE_MS = 28_000;

test.describe("when the planner service fails", () => {
  test("builds the plan on the device and labels it offline when the service cannot be reached", async ({
    page,
    press,
  }) => {
    await page.route(PLAN_ROUTE, (route) => route.abort("connectionrefused"));
    await openPlanner(page);
    await planTrip(page, press);

    await expect(page.getByTestId("source-badge")).toContainText(BADGE.offline);
    await expect(page.getByTestId("offline-label")).toBeVisible();
    expect(await badgeDetails(page, press)).toContain("could not be reached");
    expectTimesInOrder(await readStops(page));
    await expect(page.locator('[data-flagged="true"]')).toHaveCount(0);
  });

  test("a plan request that never answers ends at the page's deadline in a plan built on the device", async ({
    page,
    press,
  }) => {
    await page.route(PLAN_ROUTE, () => {
      // Held open and never answered, like a service that hangs.
    });
    await openPlanner(page);
    const sent = page.waitForRequest(PLAN_ROUTE);
    await press(page.getByTestId("plan-button"));
    await sent;
    // Decision: the browser clock is run forward instead of waiting 28 s of real time per device.
    // Just past the API's own deadline the page must still be waiting for the service's answer.
    await page.clock.runFor(API_DEADLINE_MS + 1_000);
    await expect(page.getByTestId("plan-button")).toHaveAttribute("aria-busy", "true");
    expect(await plansAnnounced(page), "gave up before the service's own deadline").toBe(0);

    await page.clock.runFor(CLIENT_DEADLINE_MS - API_DEADLINE_MS);
    await expect(page.getByTestId("source-badge")).toContainText(BADGE.onDevice);
    expect(await badgeDetails(page, press)).toContain("did not answer in time");
    expectTimesInOrder(await readStops(page));
  });

  test("never shows the service's plan as checked when it breaks a rule on the device, and plans there instead", async ({
    page,
    press,
  }) => {
    let moved = "";
    await page.route(PLAN_ROUTE, async (route) => {
      const answer = await route.fetch();
      const plan = await answer.json();
      // A stop from another base: the page's own check must catch it (OUTSIDE_ANCHOR).
      moved = await placeFromAnotherBase(page, plan.days[0].anchorId);
      plan.days[0].stops[0].placeId = moved;
      await route.fulfill({ response: answer, json: plan });
    });
    await openPlanner(page);
    await planTrip(page, press);

    await expect(page.getByTestId("source-badge")).toContainText(BADGE.onDevice);
    expect(await badgeDetails(page, press)).toContain("did not pass the checks on this device");
    await expect(page.locator('[data-flagged="true"]')).toHaveCount(0);
    expect(moved, "the route never changed the plan").not.toBe("");
    expect((await readTrip(page, press)).flatMap(placeIds)).not.toContain(moved);
  });

  test("labels a plan built after a server error as on this device, never as offline", async ({
    page,
    press,
  }) => {
    await page.route(PLAN_ROUTE, (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "plan_unavailable", message: "Unavailable", requestId: "e2e" },
        }),
      }),
    );
    await openPlanner(page);
    await planTrip(page, press);

    await expect(page.getByTestId("source-badge")).toContainText(BADGE.onDevice);
    await expect(page.getByTestId("offline-label")).toHaveCount(0);
    expect(await badgeDetails(page, press)).toContain("had an error");
  });

  test("labels a plan built after an unreadable reply as on this device", async ({
    page,
    press,
  }) => {
    await page.route(PLAN_ROUTE, (route) =>
      route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><p>hi</p>" }),
    );
    await openPlanner(page);
    await planTrip(page, press);

    await expect(page.getByTestId("source-badge")).toContainText(BADGE.onDevice);
    expect(await badgeDetails(page, press)).toContain("a reply this page cannot read");
  });

  test("a traveler over the real rate limit still gets a plan, labelled as the service being busy", async ({
    page,
    press,
  }) => {
    await openPlanner(page);
    // Use up this client's plan allowance on the real API (10 a minute), through the same proxy.
    const body = {
      startDate: DEFAULT_START_DATE,
      pace: "balanced",
      interests: [],
      maxPriceLevel: null,
      anchors: "auto",
      mustInclude: [],
      exclude: [],
    };
    let status = 200;
    for (let sent = 0; sent < 20 && status !== 429; sent++) {
      const answer = await page.request.post("/api/plan?mode=deterministic", { data: body });
      status = answer.status();
    }
    expect(status, "the API never rate limited this client").toBe(429);

    await planTrip(page, press);
    await expect(page.getByTestId("source-badge")).toContainText(BADGE.onDevice);
    expect(await badgeDetails(page, press)).toContain("busy right now");
  });

  test("keeps the previous plan on screen and says which field to fix when the API refuses a request", async ({
    page,
    press,
    twoPane,
  }) => {
    await openPlanner(page);
    await planTrip(page, press);
    const before = await readDay(page, press, 1);

    // The real API validates the body: send an impossible date as if the form had let it through.
    await page.route(PLAN_ROUTE, (route) => {
      const request = { ...route.request().postDataJSON(), startDate: "2026-02-30" };
      return route.continue({ postData: JSON.stringify(request) });
    });
    await reopenForm(page, press, twoPane);
    // Other options: the page would show the plan it already has for these, with no request.
    await press(page.getByTestId("pace-field").getByRole("radio", { name: "Packed" }));
    await press(page.getByTestId("plan-button"));

    const error = page.getByTestId("error-state");
    await expect(error).toContainText("Some trip details were not accepted. Check the start date");
    await expect(error.getByTestId("retry-button")).toHaveCount(0);
    await expect(page.getByTestId("plan-view")).toBeVisible();
    await expect(page.getByTestId("source-badge")).toContainText(BADGE.ai);
    expect(await readStops(page)).toEqual(before);
  });

  test("shows a retry when the places cannot load, and the form appears once they do", async ({
    page,
    press,
  }) => {
    await page.route("**/api/places", (route) => route.abort("connectionreset"));
    await page.goto("/");
    const error = page.getByTestId("error-state");
    await expect(error).toContainText("The planner is unavailable. Try again in a moment.");
    await expect(page.getByTestId("plan-button")).toHaveCount(0);

    await page.unroute("**/api/places");
    await press(error.getByTestId("retry-button"));
    await expect(page.getByTestId("plan-button")).toBeVisible();
    await expect(page.getByTestId("error-state")).toHaveCount(0);
  });
});
