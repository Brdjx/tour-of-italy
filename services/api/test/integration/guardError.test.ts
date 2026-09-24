import { describe, expect, it, vi } from "vitest";
import { ErrorResponseSchema } from "../../src/contract";
import { PlanGuardError } from "../../src/plan/outcome";
import { makeApp, postPlan, tripBody } from "../helpers/app";

// If even the rules-only plan failed validation (a planner bug), the traveler gets a clear 503,
// never an invalid plan and never a 500 with internals.

vi.mock("../../src/plan/planTrip", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/plan/planTrip")>();
  return {
    ...original,
    planTrip: vi.fn(async () => {
      throw new PlanGuardError("The rules-only plan failed validation");
    }),
  };
});

describe("rules-only plan that fails the guard", () => {
  it("answers 503 plan_unavailable and logs the error", async () => {
    const { app, logs } = makeApp();

    const res = await postPlan(app, tripBody(), { query: "mode=deterministic" });

    expect(res.status).toBe(503);
    const body = ErrorResponseSchema.parse(await res.json());
    expect(body.error.code).toBe("plan_unavailable");
    expect(JSON.stringify(body)).not.toContain("failed validation");
    expect(logs.join("\n")).toContain("PlanGuardError");
  });
});
