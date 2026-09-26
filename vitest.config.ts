import { defineConfig } from "vitest/config";

// One Vitest run covers every workspace package. Each project keeps its own root and environment.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "planner",
          root: "packages/planner",
          include: ["test/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "api",
          root: "services/api",
          include: ["test/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "evals",
          root: "packages/evals",
          include: ["test/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "infra",
          root: "infra",
          include: ["test/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "web",
          root: "apps/web",
          include: ["test/**/*.test.{ts,tsx}"],
          environment: "jsdom",
        },
      },
    ],
    coverage: {
      provider: "v8",
      reportsDirectory: "coverage",
      include: [
        "packages/planner/src/**/*.ts",
        "services/api/src/**/*.ts",
        "packages/evals/src/**/*.ts",
        "apps/web/lib/**/*.ts",
        "apps/web/components/**/*.tsx",
      ],
      // Decision: entry points are exercised by the dev server and the deploy smoke test, not
      // by unit tests, so they do not count against coverage. The evals measure the product
      // rather than being part of it; their own tests run in `pnpm test` without a floor.
      exclude: ["services/api/src/local.ts", "services/api/src/lambda.ts", "packages/evals/src/**"],
      // Decision: floors per area, so one well-covered package cannot hide a poorly covered one.
      // Each floor here is the measured figure on 2026-09-24 rounded down, so coverage can only
      // ratchet up (docs/testing.md, Coverage floors).
      thresholds: {
        "packages/planner/src/**/*.ts": { lines: 99, statements: 98, branches: 94, functions: 99 },
        "services/api/src/**/*.ts": { lines: 99, statements: 98, branches: 92, functions: 98 },
        "apps/web/lib/**/*.ts": { lines: 98, statements: 96, branches: 92, functions: 96 },
      },
    },
  },
});
