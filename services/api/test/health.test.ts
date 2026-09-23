import { describe, expect, it } from "vitest";
import packageJson from "../package.json" with { type: "json" };
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";

function testApp() {
  return createApp({ config: loadConfig({ NODE_ENV: "test", GIT_SHA: "abc1234" }) });
}

describe("GET /api/health", () => {
  it("returns ok with the package version and deployed commit", async () => {
    const res = await testApp().request("/api/health");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      version: packageJson.version,
      commit: "abc1234",
    });
  });

  it("only serves routes under /api", async () => {
    const res = await testApp().request("/health");

    expect(res.status).toBe(404);
  });
});
