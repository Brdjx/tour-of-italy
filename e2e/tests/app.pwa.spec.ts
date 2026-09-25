import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { BADGE, openPlanner, planTrip, readStops } from "../support/plan";

// The installable app and its service worker, against the production build served the way
// CloudFront serves it. Chromium only (the pwa-chromium project): Playwright sees and routes
// service worker traffic only there.

const SHELL_CACHE = /^italy-planner-shell-[0-9a-f]{16}(-\w+)?$/;
const API_CACHE = "italy-planner-api-v1";

/** Waits until the service worker controls the page (the first install claims open pages). */
async function waitForWorker(page: Page): Promise<void> {
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, {
    timeout: 20_000,
  });
}

/** Cache name -> the paths it holds. */
async function cacheContents(page: Page): Promise<Record<string, string[]>> {
  return page.evaluate(async () => {
    const out: Record<string, string[]> = {};
    for (const name of await caches.keys()) {
      const requests = await (await caches.open(name)).keys();
      out[name] = requests.map((request) => `${request.method} ${new URL(request.url).pathname}`);
    }
    return out;
  });
}

/** Width and height from a PNG's IHDR chunk. */
function pngSize(bytes: Buffer): { width: number; height: number } {
  expect(bytes.subarray(1, 4).toString("ascii"), "not a PNG").toBe("PNG");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

test("the manifest and page head have what install, the notch and the keyboard need, and every icon is a PNG of its size", async ({
  page,
}) => {
  await page.goto("/");
  const href = await page.locator('link[rel="manifest"]').getAttribute("href");
  expect(href).toBeTruthy();
  const manifest = await (await page.request.get(href ?? "")).json();
  expect(manifest).toMatchObject({
    name: "3 Days in Italy",
    start_url: "/",
    scope: "/",
    display: "standalone",
  });
  expect(manifest.short_name.length).toBeGreaterThan(0);
  expect(manifest.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
  expect(manifest.background_color).toMatch(/^#[0-9a-f]{6}$/i);

  const wanted = ["192x192 any", "512x512 any", "512x512 maskable"];
  const icons: { src: string; sizes: string; purpose?: string }[] = manifest.icons;
  const found = icons.map((icon) => `${icon.sizes} ${icon.purpose ?? "any"}`);
  for (const icon of wanted) expect(found, `manifest icon ${icon}`).toContain(icon);
  for (const icon of icons) {
    const answer = await page.request.get(icon.src);
    expect(answer.status(), icon.src).toBe(200);
    const [width, height] = icon.sizes.split("x").map(Number);
    expect(pngSize(await answer.body()), icon.src).toEqual({ width, height });
  }

  const touchIcon = await page.locator('link[rel="apple-touch-icon"]').getAttribute("href");
  expect(pngSize(await (await page.request.get(touchIcon ?? "")).body())).toEqual({
    width: 180,
    height: 180,
  });
  const viewport = await page.locator('meta[name="viewport"]').getAttribute("content");
  expect(viewport, "the page cannot draw under the notch").toContain("viewport-fit=cover");
  expect(viewport, "the Android keyboard covers the field being typed in").toContain(
    "interactive-widget=resizes-content",
  );
  // One status bar color per color scheme; the light one matches the manifest.
  const themes = await page
    .locator('meta[name="theme-color"]')
    .evaluateAll((metas) =>
      Object.fromEntries(
        metas.map((meta) => [meta.getAttribute("media"), meta.getAttribute("content")]),
      ),
    );
  expect(Object.keys(themes).sort()).toEqual([
    "(prefers-color-scheme: dark)",
    "(prefers-color-scheme: light)",
  ]);
  expect(themes["(prefers-color-scheme: light)"]).toBe(manifest.theme_color);
  expect(themes["(prefers-color-scheme: dark)"]).toMatch(/^#[0-9a-f]{6}$/i);
  expect(themes["(prefers-color-scheme: dark)"]).not.toBe(manifest.theme_color);
  const statusBar = page.locator('meta[name="apple-mobile-web-app-status-bar-style"]');
  await expect(statusBar).toHaveAttribute("content", "black-translucent");
  await expect(page.locator('meta[name="mobile-web-app-capable"]')).toHaveAttribute(
    "content",
    "yes",
  );
});

test("the service worker controls the page and keeps the shell and the places for offline use", async ({
  page,
}) => {
  await openPlanner(page);
  await waitForWorker(page);
  const scope = await page.evaluate(
    async () => (await navigator.serviceWorker.getRegistration())?.scope,
  );
  expect(new URL(scope ?? "").pathname).toBe("/");

  await expect
    .poll(async () => (await cacheContents(page))[API_CACHE]?.sort())
    .toEqual(["GET /api/meta", "GET /api/places"]);
  const caches = await cacheContents(page);
  const shell = Object.keys(caches).find((name) => SHELL_CACHE.test(name)) ?? "";
  expect(caches[shell]).toContain("GET /");
  expect(caches[shell]?.some((entry) => entry.startsWith("GET /_next/static/"))).toBe(true);
});

test("a plan request always goes to the server, is never answered by the worker, and is never stored", async ({
  page,
  press,
}) => {
  const fromWorker: Record<string, boolean[]> = { plan: [], places: [] };
  page.on("response", (response) => {
    const path = new URL(response.url()).pathname;
    if (path === "/api/plan") fromWorker.plan?.push(response.fromServiceWorker());
    if (path === "/api/places") fromWorker.places?.push(response.fromServiceWorker());
  });
  await openPlanner(page);
  await waitForWorker(page);
  // A reload goes through the worker, which answers the places from its cache.
  await page.reload();
  await expect(page.getByTestId("plan-button")).toBeVisible();
  await planTrip(page, press);
  // Other options: the page itself shows a plan it already has for the same options, with no
  // request at all (lib/planMemo.ts), which is not what this test is about. With a plan on
  // screen the form is in the Edit trip sheet, and the pill's words take the press.
  await press(page.getByTestId("edit-trip-button"));
  await press(page.getByTestId("pace-field").getByText("Packed", { exact: true }));
  await planTrip(page, press);

  expect(fromWorker.places, "the worker never served the places").toContain(true);
  expect(fromWorker.plan).toEqual([false, false]);
  const stored = Object.values(await cacheContents(page)).flat();
  expect(stored.filter((entry) => entry.includes("/api/plan"))).toEqual([]);
});

test("offline right after a first visit, planning still works on the device and says offline", async ({
  page,
  context,
  press,
}) => {
  await openPlanner(page);
  await waitForWorker(page);
  await context.setOffline(true);
  await expect(page.getByTestId("offline-banner")).toContainText("You are offline.");

  await planTrip(page, press);
  await expect(page.getByTestId("source-badge")).toContainText(BADGE.offline);
  await expect(page.locator('[data-flagged="true"]')).toHaveCount(0);
});

test("an offline reload shows the app and the last plan", async ({ page, context, press }) => {
  await openPlanner(page);
  await waitForWorker(page);
  await planTrip(page, press);
  const before = await readStops(page);

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByTestId("plan-view")).toBeVisible();
  expect(await readStops(page)).toEqual(before);
  await expect(page.getByTestId("source-badge")).toContainText(BADGE.ai);
  await expect(page.getByTestId("offline-banner")).toBeVisible();
});

test("a new deploy offers a reload, never swaps files under the page, and Reload works offline", async ({
  page,
  context,
  press,
}) => {
  await openPlanner(page);
  await waitForWorker(page);
  await planTrip(page, press);
  const plan = await readStops(page);
  const oldShell = Object.keys(await cacheContents(page)).find((name) => SHELL_CACHE.test(name));
  await expect(page.getByTestId("update-prompt")).toHaveCount(0);

  // Deploy: from now on this browser gets a sw.js with a new build id (see e2e/serve.mjs).
  const url = new URL(page.url());
  await context.addCookies([
    { name: "e2e-sw-build", value: "next", domain: url.hostname, path: "/" },
  ]);
  await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.update());
  await expect(page.getByTestId("update-prompt")).toContainText("A new version is available.");
  // The new worker waits; the old one still serves this page and its caches are kept.
  const waiting = await page.evaluate(
    async () => (await navigator.serviceWorker.getRegistration())?.waiting?.state,
  );
  expect(waiting).toBe("installed");
  expect(Object.keys(await cacheContents(page))).toContain(oldShell);

  // Decision: Reload is pressed offline, the hardest case: the new version must come up from
  // its own caches with the places and the plan, so an update never costs offline use.
  await context.setOffline(true);
  await Promise.all([page.waitForEvent("load"), press(page.getByTestId("update-reload"))]);
  await expect(page.getByTestId("plan-view")).toBeVisible();
  await expect(page.getByTestId("update-prompt")).toHaveCount(0);
  expect(await readStops(page)).toEqual(plan);
  const names = Object.keys(await cacheContents(page));
  expect(names).not.toContain(oldShell);
  expect(names.some((name) => name.endsWith("-next"))).toBe(true);
  expect(names, "an update threw away the places kept for offline use").toContain(API_CACHE);
});
