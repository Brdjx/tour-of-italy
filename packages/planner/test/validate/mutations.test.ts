import { describe, expect, it } from "vitest";
import { VIOLATION_SEVERITY } from "../../src/validate";
import { expectCaught } from "./mutationRunner";
import { PLAN_MUTATIONS } from "./mutationsPlan";
import { TIME_MUTATIONS } from "./mutationsTime";

// Failure vector F1, mutation half: take a known-valid trip, apply ONE corruption, and assert the
// exact violation code appears as an error at the right place. If any check in the validator is
// deleted or weakened, at least one row fails.

const MUTATIONS = [...TIME_MUTATIONS, ...PLAN_MUTATIONS];

describe("validator mutation suite", () => {
  it.each(TIME_MUTATIONS)("catches a time corruption: $name ($code)", expectCaught);

  it.each(PLAN_MUTATIONS)("catches a plan corruption: $name ($code)", expectCaught);

  it("has a mutation for every error code, so no check can be deleted unnoticed", () => {
    const covered = new Set<string>(MUTATIONS.map((m) => m.code));
    const errors = Object.entries(VIOLATION_SEVERITY).filter(
      ([, severity]) => severity === "error",
    );
    expect(errors.map(([code]) => code).filter((code) => !covered.has(code))).toEqual([]);
  });
});
