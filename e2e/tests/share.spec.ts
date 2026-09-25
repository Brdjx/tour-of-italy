import type { Page } from "@playwright/test";
import { DEFAULT_START_DATE } from "../support/env";
import { expect, test } from "../support/fixtures";
import {
  BADGE,
  openPlanner,
  type Press,
  placeFromAnotherBase,
  placeIds,
  planTrip,
  readDay,
  readTrip,
  reopenForm,
} from "../support/plan";

// Share links. Copy link saves the trip and copies its short ?t= link, which must reopen the same
// plan on another device exactly as it was saved. When saving fails it copies the ?p= link that
// rebuilds the trip from its places, and a ?p= link a stranger edited (damaged, from another
// version, stale, or carrying markup) must end in a visible note and a usable page, never a
// crash or injected content.

const DAMAGED = "This shared link is damaged and could not be opened.";

/** A ?p= value for a payload, encoded the way lib/shareLink.ts encodes it. */
function shareParam(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

interface SharePayload {
  request: Record<string, unknown> & { exclude: string[] };
  days: { anchorId: string; ids: string[] }[];
}

/** The payload inside a copied link. */
function readParam(link: string): SharePayload {
  const param = new URL(link).searchParams.get("p") ?? "";
  return JSON.parse(Buffer.from(param, "base64url").toString("utf8"));
}

const REQUEST = {
  startDate: DEFAULT_START_DATE,
  pace: "packed",
  interests: [],
  maxPriceLevel: null,
  anchors: "auto",
  mustInclude: [],
  exclude: [],
};

/** Presses Copy link and returns what reached the clipboard. */
async function copyLink(page: Page, press: Press): Promise<string> {
  await press(page.getByTestId("share-button"));
  await expect(page.getByTestId("share-button")).toHaveText(/Link copied/);
  return page.evaluate(() => (window as unknown as { __copiedText?: string }).__copiedText ?? "");
}

/** Copy link while saving fails: the ?p= link that rebuilds the trip from its places. */
async function copyRebuildLink(page: Page, press: Press): Promise<string> {
  await page.route("**/api/trips", (route) =>
    route.fulfill({ status: 503, contentType: "application/json", body: "{}" }),
  );
  const link = await copyLink(page, press);
  await page.unroute("**/api/trips");
  return link;
}

/** Opens a link as another device would: nothing saved, a fresh page. */
async function openOnAnotherDevice(page: Page, link: string): Promise<Page> {
  await page.evaluate(() => localStorage.clear());
  const other = await page.context().newPage();
  await other.goto(link);
  return other;
}

test.describe("share links", () => {
  test("reopens a copied link as the same plan, with the same times, on a page with no saved plan", async ({
    page,
    press,
  }) => {
    await openPlanner(page);
    await planTrip(page, press);
    const original = await readTrip(page, press);
    const link = await copyLink(page, press);
    expect(link).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9A-Za-z]{10}$/);

    // A second device: nothing saved, only the link. The watchdog covers this page too.
    const other = await openOnAnotherDevice(page, link);
    await expect(other.getByTestId("plan-view")).toBeVisible();
    await expect(other.getByTestId("source-badge")).toContainText(BADGE.savedAi);
    await expect(other.getByTestId("share-notice")).toHaveCount(0);
    expect(new URL(other.url()).searchParams.has("t"), "?t= left in the address bar").toBe(false);
    expect(await readTrip(other, press)).toEqual(original);
  });

  test("copies the rebuild-from-places link when the trip cannot be saved, and says so", async ({
    page,
    press,
  }) => {
    await openPlanner(page);
    await planTrip(page, press);
    const original = await readTrip(page, press);
    const link = await copyRebuildLink(page, press);
    expect(link).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?p=[A-Za-z0-9_-]+$/);
    await expect(page.getByTestId("share-note")).toContainText("the saved link could not be made");

    const other = await openOnAnotherDevice(page, link);
    await expect(other.getByTestId("plan-view")).toBeVisible();
    await expect(other.getByTestId("source-badge")).toContainText(BADGE.shared);
    await expect(other.getByTestId("share-notice")).toContainText("Opened a shared plan.");
    expect(new URL(other.url()).searchParams.has("p"), "?p= left in the address bar").toBe(false);
    expect(await readTrip(other, press)).toEqual(original);
  });

  test("a saved trip link that does not exist shows a note over a usable form", async ({
    page,
  }) => {
    await openPlanner(page, "/?t=0000000000");
    await expect(page.getByTestId("share-notice")).toContainText(
      "This saved trip could not be found.",
    );
    await expect(page.getByTestId("plan-view")).toHaveCount(0);
    await expect(page.getByTestId("plan-button")).toBeEnabled();
  });

  test("a link copied after an edit opens the edited plan, never the plan as it first arrived", async ({
    page,
    press,
  }) => {
    await openPlanner(page);
    await planTrip(page, press);
    const before = await readDay(page, press, 1);
    await press(page.getByTestId("stop-row").nth(1).getByTestId("remove-button"));
    await expect(page.getByTestId("stop-row")).toHaveCount(before.length - 1);
    const edited = await readTrip(page, press);

    const other = await openOnAnotherDevice(page, await copyLink(page, press));
    await expect(other.getByTestId("plan-view")).toBeVisible();
    expect(await readTrip(other, press)).toEqual(edited);
  });

  test("a link that names a place its own settings skip leaves it out, and planning again still skips it", async ({
    page,
    press,
    twoPane,
  }) => {
    await openPlanner(page);
    await planTrip(page, press);
    const payload = readParam(await copyRebuildLink(page, press));
    const skipped = payload.days[0]?.ids[0] ?? "";
    payload.request.exclude = [skipped];

    const other = await openOnAnotherDevice(page, `/?p=${shareParam(payload)}`);
    await expect(other.getByTestId("plan-view")).toBeVisible();
    await expect(other.getByTestId("share-notice")).toContainText("left out");
    expect((await readTrip(other, press)).flatMap(placeIds)).not.toContain(skipped);

    // The link's skip list reaches the form, so a new plan from it skips the place too.
    await reopenForm(other, press, twoPane);
    await planTrip(other, press);
    expect((await readTrip(other, press)).flatMap(placeIds)).not.toContain(skipped);
  });

  test("a link with a stop from another base leaves it out, with a note and no flagged stop", async ({
    page,
    press,
  }) => {
    await openPlanner(page);
    await planTrip(page, press);
    const payload = readParam(await copyRebuildLink(page, press));
    const first = payload.days[0];
    if (!first) throw new Error("the copied link has no days");
    const stranger = await placeFromAnotherBase(page, first.anchorId);
    first.ids.push(stranger);

    const other = await openOnAnotherDevice(page, `/?p=${shareParam(payload)}`);
    await expect(other.getByTestId("plan-view")).toBeVisible();
    await expect(other.getByTestId("share-notice")).toContainText("left out");
    await expect(other.locator('[data-flagged="true"]')).toHaveCount(0);
    expect((await readTrip(other, press)).flatMap(placeIds)).not.toContain(stranger);
  });

  test("a damaged link shows a note over a usable form and no plan", async ({ page }) => {
    await openPlanner(page, "/?p=%25%25not-base64");
    await expect(page.getByTestId("share-notice")).toContainText(DAMAGED);
    await expect(page.getByTestId("plan-view")).toHaveCount(0);
    await expect(page.getByTestId("plan-button")).toBeEnabled();
  });

  test("a link from another app version says so instead of guessing", async ({ page }) => {
    const param = shareParam({ v: 99, request: REQUEST, days: [] });
    await openPlanner(page, `/?p=${param}`);
    await expect(page.getByTestId("share-notice")).toContainText("another version of the app");
    await expect(page.getByTestId("plan-view")).toHaveCount(0);
  });

  test("a stale link with a base that no longer exists fills in its settings to plan again", async ({
    page,
  }) => {
    const day = { anchorId: "atlantis", ids: ["place_001"] };
    const param = shareParam({ v: 1, request: REQUEST, days: [day, day, day] });
    await openPlanner(page, `/?p=${param}`);
    await expect(page.getByTestId("share-notice")).toContainText("no longer fits the current data");
    await expect(page.getByTestId("plan-view")).toHaveCount(0);
    await expect(
      page.getByTestId("pace-field").getByRole("radio", { name: "Packed" }),
    ).toBeChecked();
  });

  test("markup in a link is dropped or shown as text, never run", async ({ page }) => {
    const markup = "<img src=x onerror=window.__xss=1>";
    const days = [
      { anchorId: "rome", ids: ["place_005"] },
      { anchorId: "rome", ids: ["place_010"] },
      { anchorId: "rome", ids: ["place_024"] },
    ];
    // Markup where the schema allows free text (an interest, the notes) reaches the decoder.
    const hostile = { ...REQUEST, interests: [markup], notes: markup };
    await page.goto(`/?p=${shareParam({ v: 1, request: hostile, days })}`);
    await expect(page.getByTestId("plan-view")).toBeVisible();
    await expect(page.getByTestId("share-notice")).toContainText("no longer offered");
    // Markup in an id fails the id pattern, so that link is refused as damaged.
    const badIds = days.map((day) => ({ ...day, ids: [markup] }));
    await page.goto(`/?p=${shareParam({ v: 1, request: REQUEST, days: badIds })}`);
    await expect(page.getByTestId("share-notice")).toContainText(DAMAGED);
    await expect(page.getByTestId("plan-button")).toBeVisible();

    await expect(page.locator('img[src="x"]')).toHaveCount(0);
    expect(await page.evaluate(() => "__xss" in window)).toBe(false);
  });

  test("a link longer than the limit is refused with a note, without decoding it", async ({
    page,
  }) => {
    await openPlanner(page, `/?p=${"A".repeat(9000)}`);
    await expect(page.getByTestId("share-notice")).toContainText("too long to open");
    await expect(page.getByTestId("plan-view")).toHaveCount(0);
  });
});
