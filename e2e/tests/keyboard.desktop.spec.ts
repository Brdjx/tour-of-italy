import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { plansAnnounced, readStops } from "../support/plan";

// A keyboard-only pass on the desktop layout: no mouse, no programmatic focus. Every step must
// leave focus on a visible control (never dropped to the page), so a keyboard or screen reader
// user can always continue from where they are.

interface Focused {
  testId: string | null;
  tag: string;
  inView: boolean;
  inSheet: boolean;
}

async function focused(page: Page): Promise<Focused> {
  return page.evaluate(() => {
    const element = document.activeElement as HTMLElement | null;
    const box = element?.getBoundingClientRect();
    return {
      testId: element?.getAttribute("data-testid") ?? null,
      tag: element?.tagName ?? "NONE",
      inView: Boolean(box && box.bottom > 0 && box.top < window.innerHeight && box.height > 0),
      inSheet: Boolean(element?.closest('[data-testid="alternatives-sheet"]')),
    };
  });
}

/** Presses Tab until the focused element has `testId`, and fails after `limit` presses. */
async function tabTo(page: Page, testId: string, limit = 120, key = "Tab"): Promise<void> {
  for (let presses = 0; presses < limit; presses++) {
    await page.keyboard.press(key);
    if ((await focused(page)).testId === testId) return;
  }
  throw new Error(`${key} never reached ${testId} in ${limit} presses`);
}

/** Whether the focused element, or the part of it named by `selector`, draws the focus ring. */
async function ringShows(page: Page, selector?: string): Promise<boolean> {
  return page.evaluate((part) => {
    const focusedElement = document.activeElement;
    const drawn = part ? focusedElement?.querySelector(part) : focusedElement;
    if (!drawn) return false;
    const style = getComputedStyle(drawn);
    return style.outlineStyle === "solid" && Number.parseFloat(style.outlineWidth) >= 2;
  }, selector);
}

async function expectFocusKept(page: Page, what: string): Promise<Focused> {
  const now = await focused(page);
  expect(now.tag, `${what}: focus fell to the page`).not.toBe("BODY");
  expect(now.inView, `${what}: the focused control is off screen`).toBe(true);
  return now;
}

test("plans, switches days, swaps, reorders, removes and undoes with the keyboard alone", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("plan-button")).toBeVisible();

  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to your plan" })).toBeFocused();
  await tabTo(page, "plan-button");
  const before = await plansAnnounced(page);
  await page.keyboard.press("Enter");
  await expect.poll(() => plansAnnounced(page)).toBe(before + 1);
  await expect(page.locator("#day-heading-0")).toBeFocused();
  // Focus lands there so reading starts there; the heading is not a control and draws no ring.
  expect(await ringShows(page)).toBe(false);

  // Day tabs: one tab stop, arrows move between days.
  await tabTo(page, "day-tab-1", 10, "Shift+Tab");
  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("day-tab-2")).toBeFocused();
  await expect(page.getByTestId("day-tab-2")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("End");
  await expect(page.getByTestId("day-tab-3")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Home");
  await expect(page.getByTestId("day-tab-1")).toHaveAttribute("aria-selected", "true");

  // Swap: the sheet traps focus, Escape returns it, Enter on an option swaps.
  await tabTo(page, "swap-button");
  await page.keyboard.press("Enter");
  const sheet = page.getByTestId("alternatives-sheet");
  await expect(sheet).toBeVisible();
  for (let presses = 0; presses < 12; presses++) {
    await page.keyboard.press("Tab");
    expect((await focused(page)).inSheet, "Tab left the open sheet").toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  expect((await expectFocusKept(page, "closing the sheet")).testId).toBe("swap-button");
  const original = await readStops(page);
  await page.keyboard.press("Enter");
  await tabTo(page, "alternative-option", 3);
  await page.keyboard.press("Enter");
  await expect(sheet).toHaveCount(0);
  expect((await readStops(page))[0]?.placeId).not.toBe(original[0]?.placeId);
  await expectFocusKept(page, "choosing an alternative");

  // Reorder, remove, undo: focus follows the stop that moved or came back.
  await tabTo(page, "move-down");
  const beforeMove = await readStops(page);
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await readStops(page))[1]?.placeId).toBe(beforeMove[0]?.placeId);
  await expectFocusKept(page, "moving a stop down");

  await tabTo(page, "remove-button");
  const beforeRemove = await readStops(page);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("stop-row")).toHaveCount(beforeRemove.length - 1);
  await expectFocusKept(page, "removing a stop");

  await tabTo(page, "undo-button", 120, "Shift+Tab");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("stop-row")).toHaveCount(beforeRemove.length);
  expect(await readStops(page)).toEqual(beforeRemove);
  await expectFocusKept(page, "undoing");
});

test("opens a stop's details in a sheet and comes back to Details with the keyboard alone", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("plan-button")).toBeVisible();
  await tabTo(page, "plan-button");
  const before = await plansAnnounced(page);
  await page.keyboard.press("Enter");
  await expect.poll(() => plansAnnounced(page)).toBe(before + 1);
  await expect(page.locator("#day-heading-0")).toBeFocused();

  // Details opens the sheet on its title; Tab stays inside it (or passes through the browser's
  // own controls, which reads as BODY here) and never reaches the board behind it.
  await tabTo(page, "details-button");
  const stopOf = () =>
    page.evaluate(
      () =>
        document.activeElement?.closest<HTMLElement>('[data-testid="stop-row"]')?.dataset.placeId,
    );
  const opener = await stopOf();
  expect(opener).toBeTruthy();
  await page.keyboard.press("Enter");
  const sheet = page.getByTestId("details-sheet");
  await expect(sheet).toBeVisible();
  await expect(page.getByTestId("details-title")).toBeFocused();
  for (let presses = 0; presses < 8; presses++) {
    await page.keyboard.press("Tab");
    const where = await page.evaluate(() => {
      const element = document.activeElement;
      return {
        tag: element?.tagName ?? "NONE",
        inSheet: Boolean(element?.closest('[data-testid="details-sheet"]')),
      };
    });
    expect(where.inSheet || where.tag === "BODY", "Tab reached the page behind the sheet").toBe(
      true,
    );
  }

  // Escape closes it and gives focus back to the Details button that opened it.
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  expect((await expectFocusKept(page, "closing the details")).testId).toBe("details-button");
  expect(await stopOf()).toBe(opener);
});

test("opens a stop's details and the full-screen map from the day's map with the keyboard alone", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("plan-button")).toBeVisible();
  await tabTo(page, "plan-button");
  const before = await plansAnnounced(page);
  await page.keyboard.press("Enter");
  await expect.poll(() => plansAnnounced(page)).toBe(before + 1);
  await expect(page.locator("#day-heading-0")).toBeFocused();

  // Expand map, then the stops in visiting order, each with its ring and its popup. The map comes
  // in its own chunk after the plan; on a busy machine it can still be loading when tabbing starts.
  await expect(page.getByTestId("map-expand")).toBeVisible();
  await tabTo(page, "map-expand");
  await expectFocusKept(page, "Expand map");
  expect(await ringShows(page), "Expand map shows no focus ring").toBe(true);
  const map = page.getByTestId("day-map");
  const stops = map.getByTestId("map-stop");
  const popup = page.getByTestId("map-popup");
  for (const index of [0, 1]) {
    await page.keyboard.press("Tab");
    await expect(stops.nth(index)).toBeFocused();
    expect(await ringShows(page, ".map-marker"), `stop ${index + 1} shows no ring`).toBe(true);
    await expect(popup).toBeVisible();
    await expect(popup).toHaveAccessibleName(/^Details for /);
  }

  // Enter opens the stop's details; Escape closes them and gives focus back to the stop.
  await page.keyboard.press("Enter");
  const sheet = page.getByTestId("details-sheet");
  await expect(sheet).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(stops.nth(1)).toBeFocused();

  // Expand map opens the map full screen with focus on its heading. There, Escape puts away a
  // focused stop's popup first and closes the map second, and focus returns to Expand map.
  await tabTo(page, "map-expand", 4, "Shift+Tab");
  await page.keyboard.press("Enter");
  const full = page.getByTestId("map-dialog");
  await expect(full).toBeVisible();
  await expect(page.getByTestId("map-dialog-title")).toBeFocused();
  await tabTo(page, "map-stop", 4);
  expect(await ringShows(page, ".map-marker"), "a full-screen stop shows no ring").toBe(true);
  await expect(popup).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(popup).toHaveCount(0);
  await expect(full).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(full).toBeHidden();
  await expect(page.getByTestId("map-expand")).toBeFocused();
});
