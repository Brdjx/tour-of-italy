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
      // by unit tests, so they do not count against coverage.
      exclude: ["services/api/src/local.ts", "services/api/src/lambda.ts", "packages/evals/src/**"],
    },
  },
});
