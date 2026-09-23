import { Hono } from "hono";
import packageJson from "../package.json" with { type: "json" };
import type { Config } from "./config";

// The Hono app and its routes. No platform code lives here: local.ts serves it with Node and
// lambda.ts wraps it for AWS Lambda, so tests can call app.request() directly.

export type AppDeps = {
  config: Config;
};

export type HealthResponse = {
  ok: true;
  version: string;
  commit: string;
};

export function createApp(deps: AppDeps) {
  const app = new Hono().basePath("/api");

  // Decision: health reports the deployed commit so the deploy smoke test can prove the new code
  // is live, not just that something answers.
  app.get("/health", (c) => {
    const body: HealthResponse = {
      ok: true,
      version: packageJson.version,
      commit: deps.config.gitSha,
    };
    return c.json(body);
  });

  return app;
}

export type App = ReturnType<typeof createApp>;
