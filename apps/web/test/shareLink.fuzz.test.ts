import { TRIP_DAYS, validationErrors } from "@italy/planner";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { toBase64Url } from "../lib/base64url";
import { decodeShare } from "../lib/shareLink";
import { baseRequest, ctx, GENERATED_AT } from "./fixtures";

// F9 fuzzing: whatever a stranger puts in ?p=, decoding never throws and never yields a plan
// that fails the validator. Fixed seeds keep CI runs reproducible.

const encode = (value: unknown) => toBase64Url(JSON.stringify(value));
const decode = (param: string | null) => decodeShare(param, ctx, GENERATED_AT);

describe("fuzzing", () => {
  it("never throws for any string in ?p=", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), (param) => {
        const result = decode(param);
        if (param !== "") expect(result.status === "none" ? "" : result.note).not.toBe("");
      }),
      { numRuns: 300, seed: 20260923 },
    );
  });

  it("never throws or returns an invalid plan for any JSON value", () => {
    fc.assert(
      fc.property(fc.jsonValue({ maxDepth: 4 }), (value) => {
        const result = decode(encode(value));
        expect(["invalid", "request", "plan"]).toContain(result.status);
        if (result.status === "plan") expect(validationErrors(result.itinerary, ctx)).toEqual([]);
      }),
      { numRuns: 200, seed: 20260923 },
    );
  });

  it("never returns an invalid plan for any shuffle of real ids across days", () => {
    const allIds = ctx.places.map((place) => place.id);
    fc.assert(
      fc.property(
        fc.constantFrom("rome", "florence", "milan", "venice", "bologna"),
        fc.array(fc.array(fc.constantFrom(...allIds), { maxLength: 8 }), {
          minLength: TRIP_DAYS,
          maxLength: TRIP_DAYS,
        }),
        (anchorId, dayIds) => {
          const payload = {
            v: 1,
            request: baseRequest,
            days: dayIds.map((ids) => ({ anchorId, ids })),
          };
          const result = decode(encode(payload));
          expect(result.status).not.toBe("none");
          if (result.status === "plan") expect(validationErrors(result.itinerary, ctx)).toEqual([]);
        },
      ),
      { numRuns: 150, seed: 20260923 },
    );
  });
});
