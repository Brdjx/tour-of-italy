import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import {
  BADGE,
  CHECKED,
  expectTimesInOrder,
  openPlanner,
  placeIds,
  planTrip,
  readDay,
  readStops,
  readTrip,
} from "../support/plan";

// Editing a plan: swap, remove, reorder, undo. Every edit is timed and checked again in the
// browser; an edit that breaks a rule must say so on the stop, never pass silently.

function row(page: Page, index: number): Locator {
  return page.getByTestId("stop-row").nth(index);
}

test.describe("editing a plan", () => {
  test.beforeEach(async ({ page, press }) => {
    await openPlanner(page);
    await planTrip(page, press);
  });

  test("swaps a stop for an alternative at the time the sheet offered, with no rule broken", async ({
    page,
    press,
  }) => {
    const before = await readDay(page, press, 1);
    await press(row(page, 1).getByTestId("swap-button"));
    const sheet = page.getByTestId("alternatives-sheet");
    await expect(sheet).toBeVisible();
    const option = sheet.getByTestId("alternative-option").first();
    await expect(option).toBeVisible();
    const offeredName = (await option.locator("span").first().innerText()).trim();
    const offeredTimes = await option
      .locator("time")
      .evaluateAll((times) => times.map((time) => time.getAttribute("datetime")));
    await press(option);

    await expect(sheet).toHaveCount(0);
    const swapped = row(page, 1);
    await expect(swapped.locator("h3")).toHaveText(offeredName);
    const after = await readStops(page);
    expect(after[1]?.placeId).not.toBe(before[1]?.placeId);
    expect([after[1]?.start, after[1]?.end]).toEqual(offeredTimes);
    expectTimesInOrder(after);
    await expect(page.locator('[data-flagged="true"]')).toHaveCount(0);
    await expect(page.getByTestId("source-badge")).toContainText(BADGE.edited);
  });

  test("removes a stop, retimes the day, and undo brings back the exact day", async ({
    page,
    press,
  }) => {
    const before = await readDay(page, press, 1);
    const removed = before[1]?.placeId ?? "";
    await press(row(page, 1).getByTestId("remove-button"));

    await expect(page.getByTestId("stop-row")).toHaveCount(before.length - 1);
    const after = await readStops(page);
    expect(placeIds(after)).not.toContain(removed);
    expectTimesInOrder(after);
    await expect(page.getByTestId("live-region")).toContainText("Removed");

    await press(page.getByTestId("undo-button"));
    await expect(page.getByTestId("stop-row")).toHaveCount(before.length);
    expect(await readStops(page)).toEqual(before);
    await expect(page.getByTestId("source-badge")).toHaveText(BADGE.ai + CHECKED);
  });

  test("keeps an edit when the app is reopened, instead of bringing back the plan as it arrived", async ({
    page,
    press,
  }) => {
    const before = await readDay(page, press, 1);
    await press(row(page, 1).getByTestId("remove-button"));
    await expect(page.getByTestId("stop-row")).toHaveCount(before.length - 1);
    const edited = await readTrip(page, press);

    await page.reload();
    await expect(page.getByTestId("plan-view")).toBeVisible();
    await expect(page.getByTestId("live-region")).toContainText("Showing your last plan.");
    expect(await readTrip(page, press)).toEqual(edited);
  });

  test("moves a stop down and up again, and two undos restore the original day", async ({
    page,
    press,
  }) => {
    const before = await readDay(page, press, 1);
    const [first, second] = placeIds(before);
    await press(row(page, 0).getByTestId("move-down"));
    await expect(row(page, 0)).toHaveAttribute("data-place-id", second ?? "");
    await expect(row(page, 1)).toHaveAttribute("data-place-id", first ?? "");

    await press(row(page, 1).getByTestId("move-up"));
    await expect(row(page, 0)).toHaveAttribute("data-place-id", first ?? "");
    expect(placeIds(await readStops(page))).toEqual(placeIds(before));

    await press(page.getByTestId("undo-button"));
    await press(page.getByTestId("undo-button"));
    await expect(page.getByTestId("undo-button")).toHaveCount(0);
    expect(await readStops(page)).toEqual(before);
  });

  test("never lets the first stop move up or the last move down", async ({ page, press }) => {
    const before = await readDay(page, press, 1);
    const rows = page.getByTestId("stop-row");
    await expect(rows.first().getByTestId("move-up")).toHaveAttribute("aria-disabled", "true");
    await expect(rows.last().getByTestId("move-down")).toHaveAttribute("aria-disabled", "true");
    await press(rows.first().getByTestId("move-up"), { force: true });
    await press(rows.last().getByTestId("move-down"), { force: true });
    expect(await readStops(page)).toEqual(before);
    await expect(page.getByTestId("undo-button")).toHaveCount(0);
  });

  test("flags a stop on the row and in the badge when a reorder breaks a rule, and undo clears it", async ({
    page,
    press,
  }) => {
    await readDay(page, press, 1);
    const flagged = page.locator('[data-testid="stop-row"][data-flagged="true"]');
    // Find a reorder the rules reject: move each stop toward the end one place at a time and
    // stop at the first move that breaks a rule, undoing the moves of a stop that never does.
    // Decision: not only one place down. A day whose neighbours can all swap (a plan with slack
    // between stops) still breaks a rule once a sight is moved after dinner, when it is closed.
    const count = await page.getByTestId("stop-row").count();
    let moves = 0;
    for (let index = 0; index < count - 1 && (await flagged.count()) === 0; index++) {
      moves = 0;
      for (let at = index; at < count - 1 && (await flagged.count()) === 0; at++) {
        const moved = await row(page, at).getAttribute("data-place-id");
        await press(row(page, at).getByTestId("move-down"));
        await expect(row(page, at + 1)).toHaveAttribute("data-place-id", moved ?? "");
        moves++;
      }
      if ((await flagged.count()) > 0) break;
      for (; moves > 0; moves--) await press(page.getByTestId("undo-button"));
      await expect(page.getByTestId("undo-button")).toHaveCount(0);
    }
    await expect(flagged.first(), "no reorder on day 1 broke a rule").toBeVisible();

    const errorChip = flagged.first().locator('[data-testid="warning-chip"][data-tone="error"]');
    await expect(errorChip.first()).toBeVisible();
    await press(errorChip.first());
    await expect(flagged.first().getByTestId("chip-explanation").first()).toBeVisible();
    const badge = page.getByTestId("source-badge");
    await expect(badge).toHaveAttribute("data-marker", "problem");
    await expect(badge).toHaveText(/^Planned with AI, edited, \d+ problems? to fix$/);

    // One undo takes back the move that broke the rule; the moves before it broke none.
    await press(page.getByTestId("undo-button"));
    await expect(flagged).toHaveCount(0);
    for (moves--; moves > 0; moves--) await press(page.getByTestId("undo-button"));
    await expect(page.getByTestId("undo-button")).toHaveCount(0);
    await expect(badge).toHaveText(BADGE.ai + CHECKED);
  });

  test("opens the swap sheet on the first press right after a chip explanation was opened", async ({
    page,
    press,
  }) => {
    await readDay(page, press, 1);
    const chip = page.getByTestId("warning-chip");
    const withChip = page.getByTestId("stop-row").filter({ has: chip }).first();
    await press(withChip.getByTestId("warning-chip").first());
    const explanation = withChip.locator('[data-testid="chip-explanation"]:not([hidden])');
    await expect(explanation).toBeVisible();
    // The explanation closes as focus leaves; the press that moved focus must still count.
    await press(withChip.getByTestId("swap-button"));
    await expect(page.getByTestId("alternatives-sheet")).toBeVisible();
  });
});
