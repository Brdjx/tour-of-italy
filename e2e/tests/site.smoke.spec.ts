import { expect, type Page, test } from "@playwright/test";
import { REMOTE_URL } from "../support/env";
import { useEmptyTiles } from "../support/tiles";

// The post-deploy smoke: a few checks against the live site (E2E_BASE_URL) that prove a real
// browser can load it and plan a trip. No fixtures and no scripted model: the plan uses
// ?mode=deterministic, so a smoke run never spends Claude tokens. Locally the same tests run
// against the local build, so a broken smoke test fails in CI before it can fail a deploy.

/** Collects uncaught errors and console errors from the moment the page opens. */
function watch(page: Page): string[] {
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(`page error: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(`console error: ${message.text()}`);
  });
  return problems;
}

test.beforeEach(async ({ context }) => {
  // Decision: the live site serves its own map tile archive, and the smoke reads it as a
  // traveler does. A local run has no archive (it is never in the repo), so there it reads an
  // empty one, as every other local test does.
  if (!REMOTE_URL) await useEmptyTiles(context);
});

test("the home page loads the planner with its places and no errors", { tag: "@smoke" }, async ({
  page,
}) => {
  const problems = watch(page);
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
  await expect(page).toHaveTitle("3 Days in Italy");
  await expect(page.getByTestId("plan-button")).toBeVisible();
  await expect(page.getByTestId("data-headline")).not.toBeEmpty();
  expect(problems).toEqual([]);
});

test("the API health check answers through the site's own origin", { tag: "@smoke" }, async ({
  request,
}) => {
  const response = await request.get("/api/health");
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body.ok).toBe(true);
  expect(typeof body.commit).toBe("string");
});

test("a rules-only plan comes back from the API with three days of stops in time order", {
  tag: "@smoke",
}, async ({ page }) => {
  const problems = watch(page);
  await page.goto("/?mode=deterministic");
  await expect(page.getByTestId("plan-button")).toBeVisible();
  const [response] = await Promise.all([
    page.waitForResponse((answer) => new URL(answer.url()).pathname === "/api/plan"),
    page.getByTestId("plan-button").click(),
  ]);
  // The API answered; a plan built in the browser after a failed call would also render.
  expect(response.status()).toBe(200);
  expect(new URL(response.url()).searchParams.get("mode")).toBe("deterministic");

  await expect(page.getByTestId("plan-view")).toBeVisible();
  const badge = page.getByTestId("source-badge");
  await expect(badge).toHaveAttribute("data-source", "deterministic");
  await expect(badge).toContainText("Planned without AI");
  await expect(badge).not.toContainText("on this device");
  await expect(page.getByRole("tab")).toHaveCount(3);
  for (let day = 1; day <= 3; day++) {
    await page.getByTestId(`day-tab-${day}`).click();
    await expect(page.getByTestId("day-timetable")).toHaveAttribute("data-day", String(day));
    const starts = await page
      .getByTestId("stop-row")
      .evaluateAll((rows) =>
        rows.map((row) => row.querySelector(".stop-times time")?.getAttribute("datetime") ?? ""),
      );
    expect(starts.length, `day ${day} has no stops`).toBeGreaterThan(0);
    expect(starts, `day ${day} times out of order`).toEqual([...starts].sort());
  }
  await expect(page.locator('[data-flagged="true"]')).toHaveCount(0);
  expect(problems).toEqual([]);
});
