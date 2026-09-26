import { test as base, expect, type Locator, type Page } from "@playwright/test";
import { FIXED_NOW } from "./env";

// The fixtures every local E2E test uses:
// - a fixed start for the browser clock (see FIXED_NOW), so plans are the same every day
// - a client id per test, which serve.mjs turns into a viewer address, so the API's per-client
//   rate limit sees each test as its own traveler
// - a watchdog that fails the test on any uncaught page error, Content-Security-Policy violation
//   (the page is served with the production CSP) or unexpected console error, on every page the
//   test opens
// - `press`, which taps on touch devices and clicks elsewhere, so phone projects test taps
// - `twoPane`, the layout this project's screen gets (see playwright.config.ts)

/** Records CSP violations into window.__cspViolations, from the first script on. */
function recordCspViolations(): void {
  const list: string[] = [];
  Object.defineProperty(window, "__cspViolations", { value: list });
  document.addEventListener("securitypolicyviolation", (event) => {
    list.push(`${event.violatedDirective} ${event.blockedURI}`);
  });
}

/**
 * Records every live-region announcement into window.__announcements. Each message is a new node
 * (components/StatusRegion.tsx), so counting them tells a new plan apart from the one on screen.
 */
function recordAnnouncements(): void {
  const list: string[] = [];
  Object.defineProperty(window, "__announcements", { value: list });
  new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      const region = mutation.target as Element;
      if (region.getAttribute?.("data-testid") !== "live-region") continue;
      for (const node of mutation.addedNodes) list.push(node.textContent ?? "");
    }
  }).observe(document, { childList: true, subtree: true });
}

/** Replaces the clipboard with a recorder, so copied links can be read back in every engine. */
function recordClipboard(): void {
  const clipboard = {
    writeText: async (text: string) => {
      Object.assign(window, { __copiedText: text });
    },
  };
  Object.defineProperty(navigator, "clipboard", { value: clipboard, configurable: true });
}

/**
 * The one console error a test may cause on purpose: the browser's own line for a request that
 * failed. Every such line in the suite comes from a fault a test injects (a 404, 400, 429 or 503,
 * a refused or reset connection, going offline).
 */
// Decision: an allowlist of this one line, not a per-test opt-out. Anything else logged as an
// error (a React warning, an exception the app caught and logged) fails the test that caused it.
const EXPECTED_CONSOLE_ERROR = /^Failed to load resource\b/;

/**
 * A browser notice that is never recorded at all. WebKit on Linux reports the viewport key
 * interactive-widget as unrecognized. Chromium uses the key (it keeps the Android keyboard from
 * covering inputs) and WebKit ignores it, so the line describes our own meta tag, not an app
 * error. WebKit on macOS does not log it.
 */
// Decision: dropped where console messages are collected, so no assertion (the watchdog's or a
// test's own check of consoleErrors) ever sees it.
const BROWSER_NOTICE = /^Viewport argument key "interactive-widget" not recognized and ignored\.$/;

export interface Watchdog {
  pageErrors: string[];
  consoleErrors: string[];
}

interface Fixtures {
  press: (target: Locator, options?: { force?: boolean }) => Promise<void>;
  watchdog: Watchdog;
  touch: boolean;
  twoPane: boolean;
}

export const test = base.extend<Fixtures>({
  context: async ({ context }, use, testInfo) => {
    await context.setExtraHTTPHeaders({ "x-e2e-client": `${testInfo.testId}-r${testInfo.retry}` });
    await context.clock.install({ time: FIXED_NOW });
    await context.addInitScript(recordCspViolations);
    await context.addInitScript(recordClipboard);
    await context.addInitScript(recordAnnouncements);
    await use(context);
  },

  // biome-ignore lint/correctness/noEmptyPattern: Playwright reads fixture deps from it.
  touch: async ({}, use, testInfo) => {
    await use(Boolean(testInfo.project.use.hasTouch));
  },

  // Decision: the layout is pinned per project, never read back from the page. A test that
  // accepted whichever layout the page showed would pass if the two panes were lost.
  // biome-ignore lint/correctness/noEmptyPattern: Playwright reads fixture deps from it.
  twoPane: async ({}, use, testInfo) => {
    await use(testInfo.project.metadata.layout === "two-pane");
  },

  press: async ({ touch }, use) => {
    // force skips Playwright's "enabled" wait, to press a button that is aria-disabled on
    // purpose and prove the press does nothing.
    await use(async (target, options = {}) => {
      if (touch) await target.tap(options);
      else await target.click(options);
    });
  },

  watchdog: [
    async ({ context, page }, use) => {
      const watchdog: Watchdog = { pageErrors: [], consoleErrors: [] };
      const watch = (target: Page) => {
        target.on("pageerror", (error) => watchdog.pageErrors.push(error.message));
        target.on("console", (message) => {
          if (message.type() !== "error" || BROWSER_NOTICE.test(message.text())) return;
          watchdog.consoleErrors.push(message.text());
        });
      };
      // The test's page exists already; pages it opens later (a shared link) are watched too.
      watch(page);
      context.on("page", watch);
      await use(watchdog);
      expect(watchdog.pageErrors, "uncaught errors in the page").toEqual([]);
      const unexpected = watchdog.consoleErrors.filter(
        (text) => !EXPECTED_CONSOLE_ERROR.test(text),
      );
      expect(unexpected, "console errors no injected fault explains").toEqual([]);
      const csp: string[] = [];
      for (const open of context.pages()) csp.push(...(await cspViolations(open)));
      expect(csp, "Content-Security-Policy violations").toEqual([]);
    },
    { auto: true },
  ],
});

/** CSP violations recorded in the page so far, or none when the page is gone. */
export async function cspViolations(page: Page): Promise<string[]> {
  if (page.isClosed()) return [];
  try {
    return await page.evaluate(
      () => (window as unknown as { __cspViolations?: string[] }).__cspViolations ?? [],
    );
  } catch {
    return []; // the page navigated away mid-read; the next page records its own
  }
}

export { expect };
