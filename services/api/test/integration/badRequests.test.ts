import { describe, expect, it } from "vitest";
import { ErrorResponseSchema } from "../../src/contract";
import { FIXED_NOW, makeApp, postPlan, tripBody } from "../helpers/app";

// Plan scenario 12: bad requests get a 400 (or 413/415) with the field that is wrong, before any
// model call is made. Messages name the rule, never echo the submitted value.

async function reject(body: unknown, headers?: Record<string, string>) {
  const { app } = makeApp();
  const res = await postPlan(app, body, { headers });
  const parsed = ErrorResponseSchema.parse(await res.json());
  return { status: res.status, error: parsed.error };
}

function paths(error: { details?: { path: string }[] }): string[] {
  return (error.details ?? []).map((d) => d.path);
}

describe("POST /api/plan validation", () => {
  const cases: [string, Record<string, unknown>, string][] = [
    ["an impossible date", { startDate: "2026-02-30" }, "startDate"],
    ["a date in the wrong format", { startDate: "19/10/2026" }, "startDate"],
    ["a date before the accepted years", { startDate: "1999-12-31" }, "startDate"],
    ["a trip that would end after 2100", { startDate: "2100-12-31" }, "startDate"],
    ["an unknown pace", { pace: "sprint" }, "pace"],
    ["an unknown interest tag", { interests: ["skiing"] }, "interests.0"],
    ["a price or crowd tag offered as an interest", { interests: ["budget"] }, "interests.0"],
    ["more than eight interests", { interests: Array(9).fill("art") }, "interests"],
    ["an unknown must-include id", { mustInclude: ["place_999"] }, "mustInclude.0"],
    ["an unknown excluded id", { exclude: ["eiffel-tower"] }, "exclude.0"],
    ["an unknown base", { anchors: ["paris"] }, "anchors.0"],
    ["three bases", { anchors: ["rome", "florence", "venice"] }, "anchors"],
    [
      "a place both required and excluded",
      { mustInclude: ["place_001"], exclude: ["place_001"] },
      "mustInclude.0",
    ],
    [
      "eleven must-includes",
      { mustInclude: Array.from({ length: 11 }, (_, i) => `place_00${i}`) },
      "mustInclude",
    ],
    ["notes over 500 characters", { notes: "x".repeat(501) }, "notes"],
    ["an unknown field", { hotel: "Hilton" }, ""],
    ["a price level of 5", { maxPriceLevel: 5 }, "maxPriceLevel"],
    ["a string where a list belongs", { interests: "art" }, "interests"],
    ["a number where a date belongs", { startDate: 20261019 }, "startDate"],
    ["an id with unsafe characters", { mustInclude: ["../etc/passwd"] }, "mustInclude.0"],
  ];

  for (const [name, overrides, path] of cases) {
    it(`answers 400 with the field for ${name}`, async () => {
      const { status, error } = await reject(tripBody(overrides));

      expect(status).toBe(400);
      expect(error.code).toBe("bad_request");
      expect(paths(error)).toContain(path);
    });
  }

  it("accepts notes of exactly 500 characters after trimming", async () => {
    const { app } = makeApp();

    const res = await postPlan(app, tripBody({ notes: `  ${"x".repeat(500)}  ` }), {
      query: "mode=deterministic",
    });

    expect(res.status).toBe(200);
  });

  it("accepts a start date exactly one year back, using the injected clock", async () => {
    const { app } = makeApp({ now: () => FIXED_NOW });

    const res = await postPlan(app, tripBody({ startDate: "2025-09-23" }), {
      query: "mode=deterministic",
    });

    expect(res.status).toBe(200);
  });

  it("answers 400 for a body that is not an object", async () => {
    for (const body of ["[]", "null", "42", '"text"']) {
      const { status } = await reject(body);
      expect(status).toBe(400);
    }
  });

  it("answers 400 for malformed JSON", async () => {
    const { status, error } = await reject('{"startDate": "2026-10-19",');

    expect(status).toBe(400);
    expect(error.code).toBe("invalid_json");
  });

  it("answers 413 for a 20 KB body", async () => {
    const { status, error } = await reject(tripBody({ notes: "x".repeat(20 * 1024) }));

    expect(status).toBe(413);
    expect(error.code).toBe("payload_too_large");
  });

  it("answers 415 for a body not sent as JSON", async () => {
    const { status, error } = await reject(tripBody(), { "content-type": "text/plain" });

    expect(status).toBe(415);
    expect(error.code).toBe("unsupported_media_type");
  });

  it("never echoes the submitted value in an error", async () => {
    const secret = "sk-ant-test-FAKE-value-in-a-field";

    const { error } = await reject(tripBody({ interests: [secret.slice(0, 40)], [secret]: 1 }));

    expect(JSON.stringify(error.details)).not.toContain("sk-ant-test-FAKE-value-in-a-field");
  });

  it("caps the number of details returned for a huge invalid body", async () => {
    const { error } = await reject({
      ...tripBody(),
      ...Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`k${i}`, i])),
    });

    expect(error.details?.length ?? 0).toBeLessThanOrEqual(20);
  });
});
