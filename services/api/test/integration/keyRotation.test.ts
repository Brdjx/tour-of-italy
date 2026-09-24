import type { Itinerary } from "@italy/planner";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import { loadConfig } from "../../src/config";
import { shippedData } from "../../src/data";
import { silentLogger } from "../../src/lib/logger";
import type { ParameterFetcher } from "../../src/lib/secrets";
import { LlmError } from "../../src/llm/errors";
import { validSelection } from "../../src/llm/fixtureAnswers";
import { createRuntimeDeps } from "../../src/runtime";
import { FIXED_NOW, postPlan, tripBody } from "../helpers/app";
import { ScriptedClient, textResult } from "../helpers/fakeClients";

// Rotating the Anthropic key (after a leak, say) must reach warm instances without a redeploy:
// a rejected key is re-read at once, and any key is re-read every 15 minutes. Runs the real
// runtime wiring with a fake SSM and a fake model client per key.

const { ctx } = shippedData();
const KEY_PARAM = "/italy-planner/anthropic-api-key";
const OLD_KEY = "sk-ant-old-key-for-tests-000";
const NEW_KEY = "sk-ant-new-key-for-tests-111";

function setup(revoked: ReadonlySet<string>) {
  const ssm = { value: OLD_KEY, reads: 0 };
  let now = FIXED_NOW;
  const keysUsed: string[] = [];
  const fetchParameter: ParameterFetcher = async () => {
    ssm.reads++;
    return ssm.value;
  };
  const createClient = (key: string) =>
    new ScriptedClient(async (input) => {
      keysUsed.push(key);
      if (revoked.has(key))
        throw new LlmError("auth", "Model API rejected the key", { status: 401 });
      return textResult({ selection: validSelection(input.request, input.user, ctx) });
    });
  const config = loadConfig({
    NODE_ENV: "test",
    LLM_MODE: "anthropic",
    ANTHROPIC_API_KEY_PARAM: KEY_PARAM,
  });
  const deps = createRuntimeDeps(config, {
    fetchParameter,
    createClient,
    logger: silentLogger(),
    now: () => now,
  });
  const app = createApp(deps);
  const advance = (ms: number) => {
    now += ms;
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { app, ssm, keysUsed, advance, settle };
}

describe("Anthropic key rotation", () => {
  it("re-reads a key the API rejected, so the rotated key serves the very next plan", async () => {
    const { app, ssm, keysUsed, advance, settle } = setup(new Set([OLD_KEY]));
    await settle();
    ssm.value = NEW_KEY;
    advance(61_000);

    const first = (await (await postPlan(app, tripBody())).json()) as Itinerary;
    await settle();
    const second = (await (await postPlan(app, tripBody({ pace: "relaxed" }))).json()) as Itinerary;

    expect(first.meta.fallbackReason).toBe("llm_error");
    expect(second.source).toBe("ai");
    expect(keysUsed).toEqual([OLD_KEY, NEW_KEY]);
  });

  it("reports AI unavailable in health while the only key is one the API rejected", async () => {
    const { app, settle, advance } = setup(new Set([OLD_KEY]));
    await settle();
    advance(61_000);

    await postPlan(app, tripBody());
    await settle();
    const health = await (await app.request("/api/health")).json();

    expect(health).toMatchObject({ llmAvailable: false, model: null });
  });

  it("picks up a rotated key within 15 minutes with no failure at all", async () => {
    const { app, ssm, keysUsed, advance, settle } = setup(new Set());
    await settle();
    await postPlan(app, tripBody());
    ssm.value = NEW_KEY;

    advance(15 * 60_000 + 1);
    await postPlan(app, tripBody({ pace: "packed" }));

    expect(keysUsed).toEqual([OLD_KEY, NEW_KEY]);
  });

  it("never re-reads the key more than once a minute, however many plans fail", async () => {
    const { app, ssm, advance, settle } = setup(new Set([OLD_KEY]));
    await settle();
    advance(61_000);

    for (const pace of ["relaxed", "balanced", "packed"]) {
      await postPlan(app, tripBody({ pace }));
      await settle();
    }

    expect(ssm.reads).toBe(2);
  });
});
