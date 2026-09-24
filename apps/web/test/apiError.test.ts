import { describe, expect, it } from "vitest";
import {
  ApiError,
  describeApiError,
  detailFields,
  isApiError,
  isRequestProblem,
} from "../lib/apiError";

// Error copy: never apologize, always say what to do next, never leak raw server text.

const UNAVAILABLE = "The planner is unavailable. Try again in a moment.";

describe("describeApiError", () => {
  it("tells the traveler to try again when the service is down, slow, or unreachable", () => {
    for (const kind of ["network", "timeout"] as const) {
      expect(describeApiError(new ApiError({ kind, message: "x" }))).toBe(UNAVAILABLE);
    }
    expect(describeApiError(new ApiError({ kind: "http", status: 503, message: "x" }))).toBe(
      UNAVAILABLE,
    );
    expect(describeApiError(new Error("boom"))).toBe(UNAVAILABLE);
    expect(describeApiError("not even an error")).toBe(UNAVAILABLE);
  });

  it("names the rejected fields of a 400 instead of showing the server's raw message", () => {
    const error = new ApiError({
      kind: "http",
      status: 400,
      message: "<b>server text</b>",
      details: [{ path: ["startDate"] }, { path: ["notes"] }],
    });
    const text = describeApiError(error);
    expect(text).toBe(
      "Some trip details were not accepted. Check the start date and the notes, then try again.",
    );
    expect(text).not.toContain("server text");
  });

  it("still says what to do when a 400 has no readable details", () => {
    const error = new ApiError({ kind: "http", status: 400, message: "x", details: 42 });
    expect(describeApiError(error)).toBe(
      "Some trip details were not accepted. Check the form, then try again.",
    );
  });

  it("asks the traveler to wait after a rate limit", () => {
    const error = new ApiError({ kind: "http", status: 429, message: "x" });
    expect(describeApiError(error)).toBe(
      "Too many plans in a short time. Wait a minute and try again.",
    );
  });

  it("explains an unreadable reply without showing it", () => {
    for (const kind of ["parse", "schema"] as const) {
      expect(describeApiError(new ApiError({ kind, message: "x" }))).toBe(
        "The planner sent a reply this page cannot read. Try again in a moment.",
      );
    }
  });
});

describe("detailFields", () => {
  it("reads Zod issue lists, flattened fieldErrors, and plain field lists", () => {
    expect(detailFields([{ path: ["pace"] }, { path: "anchors" }])).toEqual([
      "the pace",
      "the bases",
    ]);
    expect(detailFields({ fieldErrors: { exclude: ["x"], interests: ["y"] } })).toEqual([
      "the places to skip",
      "the interests",
    ]);
    expect(detailFields(["mustInclude", "maxPriceLevel"])).toEqual([
      "the must-see places",
      "the budget",
    ]);
  });

  it("ignores unknown fields and hostile shapes instead of throwing", () => {
    expect(detailFields([{ path: ["__proto__"] }, null, 7, { path: [{}] }])).toEqual([]);
    expect(detailFields({ fieldErrors: null })).toEqual([]);
    expect(detailFields(undefined)).toEqual([]);
    expect(detailFields(["startDate", "startDate"])).toEqual(["the start date"]);
  });
});

describe("isRequestProblem", () => {
  it("treats only bad-input statuses as the traveler's to fix", () => {
    const status = (code: number) => new ApiError({ kind: "http", status: code, message: "x" });
    expect(isRequestProblem(status(400))).toBe(true);
    expect(isRequestProblem(status(413))).toBe(true);
    expect(isRequestProblem(status(403))).toBe(false);
    expect(isRequestProblem(status(500))).toBe(false);
    expect(isRequestProblem(new ApiError({ kind: "network", message: "x" }))).toBe(false);
    expect(isApiError(new Error("x"))).toBe(false);
  });
});
