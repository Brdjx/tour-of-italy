import type { Locator, Page } from "@playwright/test";
import { expect } from "./fixtures";

// Page helpers for the planner: open it, plan a trip, read the timetable back as data.

export const TRIP_DAYS = 3;

/** The press fixture: tap on touch devices, click elsewhere. */
export type Press = (target: Locator, options?: { force?: boolean }) => Promise<void>;

/** The source line's claims for each way a plan can be made (lib/sourceText.ts). */
export const BADGE = {
  ai: "Planned with AI",
  aiRepaired: "Planned with AI, fixed after a check",
  rules: "Planned without AI",
  offline: "Planned on this device, offline",
  onDevice: "Planned on this device",
  shared: "Shared plan, rebuilt from its places",
  savedAi: "Saved trip, planned with AI",
  edited: "Planned with AI, edited",
} as const;

/** The words a screen reader hears after a checked plan's claim (components/SourceBadge.tsx). */
export const CHECKED = ", checked against opening hours and travel time";

/** Scripted model answers the local API plays (services/api/src/llm/fixture.ts). */
export type Scenario = "valid" | "unknown-id-then-valid" | "always-invalid" | "injection-echo";

export interface StopData {
  placeId: string;
  start: string; // local date-time of the start, e.g. 2026-10-15T09:35
  end: string;
}

/** Opens the planner and waits until the places are loaded and the form can be used. */
export async function openPlanner(page: Page, path = "/"): Promise<void> {
  await page.goto(path);
  await expect(page.getByTestId("plan-button")).toBeVisible();
}

/** Sends every plan request with the x-fixture-scenario header, as a route rewrite. */
export async function useScenario(page: Page, scenario: Scenario): Promise<void> {
  await page.route("**/api/plan*", async (route) => {
    const headers = { ...route.request().headers(), "x-fixture-scenario": scenario };
    await route.continue({ headers });
  });
}

/** How many times the page has announced a new plan since it loaded. */
export async function plansAnnounced(page: Page): Promise<number> {
  return page.evaluate(() => {
    const list = (window as unknown as { __announcements?: string[] }).__announcements ?? [];
    return list.filter((text) => text.startsWith("Your plan is ready")).length;
  });
}

/**
 * Presses "Plan my trip" and waits for the new plan. On phones the previous plan stays on screen
 * while the form is open, so waiting for a plan to be visible is not enough: this waits for the
 * page to announce one more plan than before.
 */
export async function planTrip(page: Page, press: Press) {
  const before = await plansAnnounced(page);
  await press(page.getByTestId("plan-button"));
  await expect
    .poll(() => plansAnnounced(page), { message: "no new plan arrived" })
    .toBe(before + 1);
  await expect(page.getByTestId("plan-view")).toBeVisible();
  await expect(page.getByTestId("stop-row").first()).toBeVisible();
}

/** The active day's stops, in the order the timetable lists them. */
export async function readStops(page: Page): Promise<StopData[]> {
  return page.getByTestId("stop-row").evaluateAll((rows) =>
    rows.map((row) => {
      const times = row.querySelectorAll(".stop-times time");
      return {
        placeId: row.getAttribute("data-place-id") ?? "",
        start: times[0]?.getAttribute("datetime") ?? "",
        end: times[1]?.getAttribute("datetime") ?? "",
      };
    }),
  );
}

/** Opens a day's tab (1-based) and returns its stops. */
export async function readDay(page: Page, press: Press, day: number): Promise<StopData[]> {
  const tab = page.getByTestId(`day-tab-${day}`);
  await press(tab);
  await expect(tab).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("day-timetable")).toHaveAttribute("data-day", String(day));
  return readStops(page);
}

/** Every day of the plan, as shown on screen. */
export async function readTrip(page: Page, press: Press) {
  const days: StopData[][] = [];
  for (let day = 1; day <= TRIP_DAYS; day++) days.push(await readDay(page, press, day));
  return days;
}

/** Fails unless every stop starts before it ends and after the previous stop ended. */
export function expectTimesInOrder(stops: readonly StopData[]): void {
  expect(stops.length, "a day with no stops").toBeGreaterThan(0);
  let previousEnd = "";
  for (const stop of stops) {
    expect(stop.start, `${stop.placeId} has no start time`).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d/);
    expect(stop.end > stop.start, `${stop.placeId} ends before it starts`).toBe(true);
    expect(stop.start >= previousEnd, `${stop.placeId} overlaps the stop before it`).toBe(true);
    previousEnd = stop.end;
  }
}

/** Each stop's place id, in visiting order. */
export function placeIds(stops: readonly StopData[]): string[] {
  return stops.map((stop) => stop.placeId);
}

/** A place that belongs to another base than `anchorId` (Rome, or Venice for a Rome day). */
export async function placeFromAnotherBase(page: Page, anchorId: string): Promise<string> {
  const body = await (await page.request.get("/api/places")).json();
  const places: { id: string; city: string }[] = Array.isArray(body) ? body : body.places;
  const city = anchorId === "rome" ? "Venice" : "Rome";
  const found = places.find((place) => place.city === city)?.id;
  if (!found) throw new Error(`no place in ${city} in /api/places`);
  return found;
}

/**
 * Gets back to the form once there is a plan. Phones and portrait tablets fold it away behind
 * "Edit trip"; two-pane screens keep it beside the plan, with no such button.
 */
export async function reopenForm(page: Page, press: Press, twoPane: boolean) {
  const edit = page.getByTestId("edit-trip-button");
  if (twoPane) await expect(edit).toBeHidden();
  else await press(edit);
  await expect(page.getByTestId("plan-button")).toBeVisible();
}
