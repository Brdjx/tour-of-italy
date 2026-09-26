import { join } from "node:path";
import { defineConfig, devices, type Project } from "@playwright/test";
import { API_PORT, LOCAL_URL, REMOTE_URL, TIME_ZONE, WEB_PORT } from "./support/env";

// End-to-end tests. Locally and in CI this builds the static export, starts the API with the
// scripted model client (LLM_MODE=fixture: no key, no network, no cost) and serves both from one
// origin through e2e/serve.mjs, the way CloudFront does in production. With E2E_BASE_URL set
// (the post-deploy job) only the @smoke tests run, against that site, and nothing is started.
//
//   pnpm test:e2e          every project below
//   pnpm test:e2e:smoke    the smoke project (E2E_BASE_URL=https://... for production)
//   E2E_SKIP_BUILD=1       reuse apps/web/out instead of building it again (local iteration)
//   E2E_REUSE=1            test against servers already running on the ports (local iteration)

const CI = Boolean(process.env.CI);
// Decision: reusing a running server is opt-in. The ports are fixed and several people (or
// agents) run this suite on one machine, so a server left from another checkout or another build
// would be tested in place of this source, green or red. Without E2E_REUSE a busy port fails
// the run at once with Playwright's "already used" error.
const REUSE = process.env.E2E_REUSE === "1" && !CI;
const REPO = join(import.meta.dirname, "..");

// Spec files by where they run: *.spec.ts on every device, *.desktop.spec.ts on the desktop
// only, *.pwa.spec.ts in the service worker project, *.smoke.spec.ts in the smoke project.
const DEVICE_ONLY = [/\.desktop\.spec\.ts$/, /\.pwa\.spec\.ts$/, /\.smoke\.spec\.ts$/];

// Decision: service workers are blocked on the device projects. A worker answers some requests
// itself, which hides them from page.route, so the fault-injection tests would test the cache
// instead of the page. The PWA project turns them on and tests the worker directly.
const deviceDefaults = { serviceWorkers: "block", timezoneId: TIME_ZONE } as const;

/**
 * Where each screen puts the day's map (apps/web/app/styles/map.css): beside the day's board from
 * 1024 px (iPad landscape, desktop), under it below that (phones, iPad portrait). Every screen is
 * one column with the form in the Edit trip sheet once there is a plan. Tests read it through the
 * `mapBeside` fixture.
 */
type Layout = "map-below" | "map-beside";

function device(name: string, descriptor: (typeof devices)[string], layout: Layout): Project {
  return {
    name,
    testIgnore: DEVICE_ONLY,
    metadata: { layout },
    use: { ...descriptor, ...deviceDefaults },
  };
}

const desktop = { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } };

const localProjects: Project[] = [
  // The phones, tablets and desktop the app is designed for (docs/testing.md).
  device("webkit-iphone-se", devices["iPhone SE (3rd gen)"], "map-below"),
  device("webkit-iphone-15-pro", devices["iPhone 15 Pro"], "map-below"),
  device("webkit-ipad-pro-11", devices["iPad Pro 11"], "map-below"),
  device("webkit-ipad-pro-11-landscape", devices["iPad Pro 11 landscape"], "map-beside"),
  device("chromium-pixel-7", devices["Pixel 7"], "map-below"),
  {
    name: "chromium-desktop",
    testIgnore: [/\.pwa\.spec\.ts$/, /\.smoke\.spec\.ts$/],
    metadata: { layout: "map-beside" satisfies Layout },
    use: { ...desktop, ...deviceDefaults },
  },
  {
    // Chromium only: Playwright can inspect and route service worker traffic only there.
    name: "pwa-chromium",
    testMatch: /\.pwa\.spec\.ts$/,
    metadata: { layout: "map-beside" satisfies Layout },
    use: { ...desktop, serviceWorkers: "allow", timezoneId: TIME_ZONE },
  },
];

const smokeProject: Project = {
  name: "smoke",
  testMatch: /\.smoke\.spec\.ts$/,
  grep: /@smoke/,
  use: { ...desktop, baseURL: REMOTE_URL ?? LOCAL_URL },
};

// The API as a developer runs it, with every setting pinned so a local .env cannot change the
// run: empty values count as unset in the API config and win over the .env file.
const apiEnv = {
  PORT: String(API_PORT),
  HOST: "127.0.0.1",
  NODE_ENV: "development",
  LLM_MODE: "fixture",
  LLM_ENABLED: "true",
  ANTHROPIC_API_KEY: "",
  ANTHROPIC_API_KEY_PARAM: "",
  ORIGIN_VERIFY_PARAM: "",
  LLM_TIMEOUT_MS: "15000",
  PLAN_DEADLINE_MS: "24000",
  LLM_MAX_ATTEMPTS: "2",
  LOG_LEVEL: "warn",
  GIT_SHA: "e2e",
};

const build = process.env.E2E_SKIP_BUILD ? "" : "pnpm --filter @italy/web build && ";

export default defineConfig({
  testDir: "tests",
  outputDir: "test-results",
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  // Decision: 4 workers in CI (the runner has 4 cores). Locally Playwright's default, half the
  // cores, keeps the machine usable while the suite runs.
  ...(CI ? { workers: 4 } : {}),
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: CI
    ? [["list"], ["github"], ["html", { open: "never", outputFolder: "playwright-report" }]]
    : [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    baseURL: LOCAL_URL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: REMOTE_URL ? [smokeProject] : [...localProjects, smokeProject],
  webServer: REMOTE_URL
    ? undefined
    : [
        {
          name: "api",
          // Decision: node --import tsx, not pnpm exec: one process, so stopping the run stops it.
          command: "node --import tsx services/api/src/local.ts",
          cwd: REPO,
          url: `http://127.0.0.1:${API_PORT}/api/health`,
          env: apiEnv,
          reuseExistingServer: REUSE,
          timeout: 60_000,
          stdout: "ignore",
          stderr: "pipe",
        },
        {
          name: "web",
          command: `${build}node e2e/serve.mjs`,
          cwd: REPO,
          url: `${LOCAL_URL}/`,
          // Decision: an empty NEXT_PUBLIC_API_BASE pins the build to same-origin /api, so an
          // apps/web/.env.local pointing at another API cannot leak into the tested build.
          env: {
            NEXT_PUBLIC_API_BASE: "",
            E2E_WEB_PORT: String(WEB_PORT),
            E2E_API_PORT: String(API_PORT),
          },
          reuseExistingServer: REUSE,
          timeout: 300_000,
          stdout: "ignore",
          stderr: "pipe",
        },
      ],
});
