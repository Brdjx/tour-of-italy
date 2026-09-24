import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import { shippedData } from "../../src/data";
import { createLogger } from "../../src/lib/logger";
import { LlmError } from "../../src/llm/errors";
import { FIXED_NOW, makeApp, postPlan, testConfig, tripBody } from "../helpers/app";
import { ScriptedClient } from "../helpers/fakeClients";

// Failure vector F4: secret leakage. A planted fake key and origin secret must never appear in
// a log line or a response body, whatever path the request takes, and errors never carry stack
// traces or internal messages to the client.

const FAKE_KEY = "sk-ant-test-FAKE-abcdefghijklmnopqrstuvwxyz0123";
const ORIGIN_SECRET = "origin-secret-planted-9c1e77";

describe("secret leakage", () => {
  it("never writes the key or origin secret to any log line or response, on any path", async () => {
    const lines: string[] = [];
    const logger = createLogger({ level: "debug", sink: (line) => lines.push(line) });
    logger.addSecret(FAKE_KEY);
    const leakyClient = new ScriptedClient(async () => {
      throw new LlmError("auth", `401 invalid x-api-key ${FAKE_KEY}`, {
        cause: new Error(`request had key ${FAKE_KEY}`),
        // The API's own error details are logged per failed call; they must be scrubbed too.
        detail: { apiMessage: `invalid x-api-key: ${FAKE_KEY}`, apiRequestId: "req_1" },
      });
    });
    const { app } = makeApp({
      client: leakyClient,
      logger,
      env: { ANTHROPIC_API_KEY: FAKE_KEY },
    });
    const bodies: string[] = [];

    // Decision: a plan echoes the traveler's own request (notes included) back to them; that is
    // their input, not a leak. Everything else in every body, and every log line, must be clean.
    const withoutEcho = (text: string) => {
      const json = JSON.parse(text);
      if (json && typeof json === "object" && "request" in json) json.request = "(own request)";
      return JSON.stringify(json);
    };
    for (const res of [
      await postPlan(app, tripBody({ notes: `my key is ${FAKE_KEY}` })),
      await postPlan(app, tripBody({ notes: FAKE_KEY.repeat(10).slice(0, 500) })),
      await postPlan(app, `{"startDate":"${FAKE_KEY}"}`),
      await postPlan(app, tripBody({ [FAKE_KEY]: true })),
      await app.request("/api/health", { headers: { "x-origin-verify": ORIGIN_SECRET } }),
      await app.request("/api/meta", { headers: { authorization: `Bearer ${FAKE_KEY}` } }),
    ]) {
      bodies.push(withoutEcho(await res.text()));
    }

    const everything = [...lines, ...bodies].join("\n");
    expect(everything).not.toContain(FAKE_KEY);
    expect(everything).not.toContain(ORIGIN_SECRET);
    expect(lines.length).toBeGreaterThanOrEqual(6);
  });

  it("logs traveler notes cut to 80 characters, never whole", async () => {
    const { app, logs } = makeApp();
    const notes = `start ${"n".repeat(300)} end-marker`;

    await postPlan(app, tripBody({ notes }), { query: "mode=deterministic" });

    const line = logs.find((l) => l.includes('"notes"')) ?? "";
    expect(line).not.toContain("end-marker");
    expect((JSON.parse(line).notes as string).length).toBeLessThanOrEqual(83);
  });

  it("answers an unexpected error with a fixed 500 message, no stack, no internal text", async () => {
    const lines: string[] = [];
    const app = createApp({
      config: testConfig({ LLM_MODE: "off" }),
      logger: createLogger({ sink: (line) => lines.push(line) }),
      now: () => FIXED_NOW,
    });
    app.get("/boom", () => {
      throw new Error(`database password hunter2 and ${FAKE_KEY}`);
    });

    const res = await app.request("/api/boom");
    const text = await res.text();

    expect(res.status).toBe(500);
    expect(JSON.parse(text)).toMatchObject({
      error: { code: "internal_error", message: "Something went wrong. Please try again." },
    });
    expect(text).not.toMatch(/hunter2|sk-ant|at .*\.ts|Error:/);
    const logged = lines.join("\n");
    expect(logged).toContain("hunter2");
    expect(logged).not.toContain(FAKE_KEY);
  });

  it("keeps the data summary and places free of anything secret-shaped", async () => {
    const { app } = makeApp();

    const text = await (await app.request("/api/places")).text();

    expect(text).not.toMatch(/sk-ant-|AKIA[A-Z0-9]{16}/);
    expect(shippedData().dataset.places.length).toBeGreaterThan(0);
  });
});
