import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ErrorResponseSchema } from "../../src/contract";
import { shippedData } from "../../src/data";
import { makeApp, postPlan, START_DATE } from "../helpers/app";
import { expectValidItinerary } from "../helpers/validPlan";

// Fuzzing POST /api/plan: no body, however strange, may produce a 500 or an invalid plan. Every
// answer is a valid plan or a JSON error. FC_RUNS raises the run count for nightly runs.

const RUNS = Number(process.env.FC_RUNS ?? 60);
const SEED = 20260923;
const ALLOWED = new Set([200, 400, 413, 415, 422]);
const { ctx, interestTags } = shippedData();
const placeIds = [...ctx.placesById.keys()];
const anchorIds = [...ctx.anchorById.keys()];

async function check(app: ReturnType<typeof makeApp>["app"], body: string, scenario?: string) {
  const res = await postPlan(app, body, { scenario });
  const json = await res.json();
  expect(ALLOWED.has(res.status), `status ${res.status} for ${body.slice(0, 200)}`).toBe(true);
  if (res.status === 200) expectValidItinerary(json);
  else ErrorResponseSchema.parse(json);
}

/** Near-valid requests: every field from its real domain, plus some wrong values mixed in. */
const nearValid = fc.record(
  {
    startDate: fc.oneof(
      fc.constant(START_DATE),
      fc
        .date({
          min: new Date(Date.UTC(2025, 0, 1)),
          max: new Date(Date.UTC(2030, 0, 1)),
          noInvalidDate: true,
        })
        .map((d) => d.toISOString().slice(0, 10)),
      fc.string(),
    ),
    pace: fc.oneof(fc.constantFrom("relaxed", "balanced", "packed"), fc.string()),
    interests: fc.oneof(fc.subarray(interestTags, { maxLength: 9 }), fc.array(fc.string())),
    maxPriceLevel: fc.oneof(fc.constantFrom(null, 1, 2, 3, 4), fc.integer()),
    anchors: fc.oneof(fc.constant("auto"), fc.subarray(anchorIds, { minLength: 1, maxLength: 3 })),
    mustInclude: fc.subarray(placeIds, { maxLength: 4 }),
    exclude: fc.subarray(placeIds, { maxLength: 11 }),
    notes: fc.string({ maxLength: 600 }),
  },
  { requiredKeys: ["startDate", "pace"] },
);

describe("POST /api/plan fuzz", () => {
  it("never answers 500 for arbitrary JSON bodies", async () => {
    const { app } = makeApp({ env: { LLM_MODE: "off" } });

    await fc.assert(
      fc.asyncProperty(fc.jsonValue(), async (value) => {
        await check(app, JSON.stringify(value));
      }),
      { numRuns: RUNS, seed: SEED },
    );
  });

  it("never answers 500 for arbitrary text bodies", async () => {
    const { app } = makeApp({ env: { LLM_MODE: "off" } });

    await fc.assert(
      fc.asyncProperty(fc.string({ maxLength: 2000 }), async (text) => {
        await check(app, text);
      }),
      { numRuns: RUNS, seed: SEED },
    );
  });

  it("answers near-valid requests with a valid plan or a field error, on the AI path too", async () => {
    const { app } = makeApp();

    await fc.assert(
      fc.asyncProperty(
        nearValid,
        fc.constantFrom("valid", "unknown-id-then-valid", "always-invalid"),
        async (body, scenario) => {
          await check(app, JSON.stringify(body), scenario);
        },
      ),
      { numRuns: RUNS, seed: SEED },
    );
  });

  it("never answers 500 for deeply nested JSON", async () => {
    const { app } = makeApp({ env: { LLM_MODE: "off" } });
    const deep = `${"[".repeat(5000)}${"]".repeat(5000)}`;
    const deepObject = `${'{"a":'.repeat(2000)}1${"}".repeat(2000)}`;

    await check(app, deep);
    await check(app, deepObject);
  });
});
