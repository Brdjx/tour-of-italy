import { describe, expect, it, vi } from "vitest";
import { ErrorResponseSchema } from "../../src/contract";
import { PlanGuardError } from "../../src/plan/outcome";
import { makeApp } from "../helpers/app";
import { dayBody, plannedTrip, postDay } from "../helpers/day";

// If even the rules-only day failed the guard (a planner bug), the traveler gets a clear 503,
// never an invalid day; any other error is the app's 500 with no internals.

const replanDay = vi.hoisted(() => vi.fn());
vi.mock("../../src/plan/replanDay", () => ({ replanDay }));

const rome = plannedTrip();

describe("POST /api/plan/day when the pipeline throws", () => {
  it("answers 503 plan_unavailable for a guard failure, and logs the error", async () => {
    replanDay.mockRejectedValueOnce(new PlanGuardError("The rules-only day failed validation"));
    const { app, logs } = makeApp();

    const res = await postDay(app, dayBody(rome, 2, "florence"));

    expect(res.status).toBe(503);
    const body = ErrorResponseSchema.parse(await res.json());
    expect(body.error.code).toBe("plan_unavailable");
    expect(JSON.stringify(body)).not.toContain("failed validation");
    expect(logs.join("\n")).toContain("PlanGuardError");
  });

  it("answers 500 for anything else", async () => {
    replanDay.mockRejectedValueOnce(new TypeError("boom"));
    const { app } = makeApp();

    const res = await postDay(app, dayBody(rome, 2, "florence"));

    expect(res.status).toBe(500);
    expect(ErrorResponseSchema.parse(await res.json()).error.code).toBe("internal_error");
  });

  it("refuses an unknown mode before planning (400)", async () => {
    const { app } = makeApp();
    const before = replanDay.mock.calls.length;

    const res = await postDay(app, dayBody(rome, 2, "florence"), { query: "mode=fast" });

    expect(res.status).toBe(400);
    expect(replanDay.mock.calls.length).toBe(before);
  });
});
