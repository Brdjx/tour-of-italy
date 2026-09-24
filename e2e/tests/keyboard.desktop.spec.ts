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
