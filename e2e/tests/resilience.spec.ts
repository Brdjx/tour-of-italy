import type { APIResponse } from "@playwright/test";
import { DEFAULT_START_DATE } from "../support/env";
import { expect, test } from "../support/fixtures";
import {
  BADGE,
  expectTimesInOrder,
  openMoreOptions,
  openPlanner,
  PAGE_PLAN_DEADLINE_MS,
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
const PLACES_ROUTE = "**/api/places";

/** The API's own deadline for a plan (PLAN_DEADLINE_MS in playwright.config.ts). */
const API_DEADLINE_MS = 24_000;
/**
 * How far off the next plan must be when the page's request is let through to the API: a refusal
 * with Retry-After 4 leaves more than 3 s. In 64 runs with 12 workers and the CPU loaded, the API
 * answered the page's request at most 1.3 s after the refusal, and with 4 waiting out a shorter
 * refusal kept the plan under 5 s of planTrip's 10 (26 September 2026).
 */
const REFUSED_FOR_S = 4;

/**
 * Sends plans with `spend` until the API refuses one with Retry-After of at least `seconds`, and
 * returns that Retry-After, or 0 if none came. A shorter refusal means a plan is due back soon:
 * the loop asks again every 250 ms until it gets that plan, which puts the next one 6 s away.
 */
async function spendUntilRefused(spend: () => Promise<APIResponse>, seconds: number) {
  for (let sent = 0; sent < 40; sent++) {
    const answer = await spend();
    if (answer.status() !== 429) continue;
    const retryAfter = Number(answer.headers()["retry-after"]);
    if (retryAfter >= seconds) return retryAfter;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return 0;
}

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

    await page.clock.runFor(PAGE_PLAN_DEADLINE_MS - API_DEADLINE_MS);
    await expect(page.getByTestId("source-badge")).toContainText(
      `${BADGE.onDevice}: the server timed out`,
    );
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

    await expect(page.getByTestId("source-badge")).toContainText(
      `${BADGE.onDevice}: the server's plan broke a rule`,
    );
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
    await expect(page.getByTestId("source-badge")).toContainText(
      `${BADGE.onDevice}: the server failed`,
    );
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

    await expect(page.getByTestId("source-badge")).toContainText(
      `${BADGE.onDevice}: the reply was unreadable`,
    );
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
    // page.request is not routed, so these reach the API even while the page's request is held.
    const spend = () => page.request.post("/api/plan?mode=deterministic", { data: body });
    let status = 200;
    for (let sent = 0; sent < 20 && status !== 429; sent++) {
      const answer = await spend();
      status = answer.status();
    }
    expect(status, "the API never rate limited this client").toBe(429);

    // Decision: the page's own plan request waits here until the API refuses this client with
    // the next plan at least REFUSED_FOR_S away, then leaves at once. The bucket gives a plan
    // back every 6 s, so a refusal is only good until then. Sent after the loop above, the
    // request lost that race in 4 of 32 runs with 12 workers (26 September 2026): the loop took
    // up to 6.7 s, the refusal said 1 to 2 s, and the API answered the page 0.3 to 1.7 s later.
    let refusedFor = 0;
    let letThrough = () => {};
    const sent = new Promise<void>((resolve) => (letThrough = resolve));
    await page.route(PLAN_ROUTE, async (route) => {
      try {
        refusedFor = await spendUntilRefused(spend, REFUSED_FOR_S);
      } finally {
        letThrough();
        await route.continue();
      }
    });
    // The wait for the plan starts once the request is let through (see planTrip).
    await planTrip(page, press, { sent });
    expect(
      refusedFor,
      "no long enough refusal came before the page's request",
    ).toBeGreaterThanOrEqual(REFUSED_FOR_S);
    await expect(page.getByTestId("source-badge")).toContainText(
      `${BADGE.onDevice}: the server was busy`,
    );
  });

  test("keeps the previous plan on screen and says which field to fix when the API refuses a request", async ({
    page,
    press,
  }) => {
    await openPlanner(page);
    await planTrip(page, press);
    const before = await readDay(page, press, 1);

    // The real API validates the body: send an impossible date as if the form had let it through.
    await page.route(PLAN_ROUTE, (route) => {
      const request = { ...route.request().postDataJSON(), startDate: "2026-02-30" };
      return route.continue({ postData: JSON.stringify(request) });
    });
    await reopenForm(page, press);
    // Other options: the page would show the plan it already has for these, with no request.
    // The pill's words take the press; its radio is visually hidden under them.
    await press(page.getByTestId("pace-field").getByText("Packed", { exact: true }));
    await press(page.getByTestId("plan-button"));

    const error = page.getByTestId("error-state");
    await expect(error).toContainText("Some trip details were not accepted. Check the start date");
    await expect(error.getByTestId("retry-button")).toHaveCount(0);
    await expect(page.getByTestId("plan-view")).toBeVisible();
    await expect(page.getByTestId("source-badge")).toContainText(BADGE.ai);
    expect(await readStops(page)).toEqual(before);
  });

  test("keeps planning with the date and pace when the places cannot load, and Try again brings the options back", async ({
    page,
    press,
  }) => {
    await page.route(PLACES_ROUTE, (route) => route.abort("connectionreset"));
    await page.goto("/");
    const missing = page.getByTestId("options-error");
    await expect(missing).toContainText(
      "Interests and places could not load. You can still plan with the date and pace.",
    );
    await expect(page.getByTestId("plan-button")).toBeEnabled();

    await page.unroute(PLACES_ROUTE);
    await press(missing.getByTestId("options-retry"));
    await expect(missing).toHaveCount(0);
    await expect(page.getByTestId("data-notes-link")).toBeVisible();
    const options = await openMoreOptions(page, press);
    await expect(options.getByTestId("skip-field").getByRole("combobox")).toBeVisible();
  });

  test("a plan that arrives while the places cannot load waits for them, and shows once Try again loads them", async ({
    page,
    press,
  }) => {
    await page.route(PLACES_ROUTE, (route) => route.abort("connectionreset"));
    await page.goto("/");
    await expect(page.getByTestId("options-error")).toBeVisible();
    await press(page.getByTestId("plan-button"));

    // The page cannot check or show the plan without the places, and says what to do.
    const error = page.getByTestId("error-state");
    await expect(error).toContainText("Your plan is ready, but the place details did not load");
    await expect(page.getByTestId("plan-view")).toHaveCount(0);

    await page.unroute(PLACES_ROUTE);
    await press(error.getByTestId("retry-button"));
    await expect(page.getByTestId("plan-view")).toBeVisible();
    await expect(page.getByTestId("error-state")).toHaveCount(0);
    await expect(page.getByTestId("source-badge")).toContainText(BADGE.ai);
    for (const stops of await readTrip(page, press)) expectTimesInOrder(stops);
  });
});
