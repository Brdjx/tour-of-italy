import { describe, expect, it } from "vitest";
import { type Expect, ExpectSchema } from "../src/cases";
import { type CheckInput, checkExpectations } from "../src/expectations";
import { ctx, plan } from "./helpers";

// Expectation checks decide the per-case pass or fail in the report. Each must fail exactly when
// the plan (or the model's rejected answer) breaks it, and skip, not pass, when it cannot apply.

const rome = plan({ interests: ["food"], anchors: ["rome"] });
const romeIds = rome.days.flatMap((d) => d.stops.map((s) => s.placeId));

function run(expect: Partial<Expect>, input: Partial<CheckInput> = {}) {
  const full = ExpectSchema.parse({ maxAnchors: 2, minPreferenceMatch: 0, ...expect });
  return checkExpectations(
    full,
    { itinerary: rome, rejectedCodes: [], preferenceMatch: 0.7, textChecks: true, ...input },
    ctx,
  );
}

const statusOf = (results: ReturnType<typeof run>, name: string) =>
  results.find((r) => r.name === name)?.status;

describe("expectation checks", () => {
  it("catches a forbidden code in an answer the pipeline rejected, although the final plan is clean", () => {
    const results = run(
      { forbidViolationCodes: ["CLOSED_AT_TIME"] },
      { rejectedCodes: ["CLOSED_AT_TIME", "UNKNOWN_PLACE"] },
    );
    expect(results.find((r) => r.name === "forbidViolationCodes")).toMatchObject({
      status: "fail",
      detail: "CLOSED_AT_TIME",
    });
    expect(
      statusOf(run({ forbidViolationCodes: ["CLOSED_AT_TIME"] }), "forbidViolationCodes"),
    ).toBe("pass");
  });

  it("fails an expected warning the plan does not carry", () => {
    expect(
      statusOf(run({ expectWarningCodes: ["MUST_INCLUDE_UNPLACEABLE"] }), "expectWarningCodes"),
    ).toBe("fail");
  });

  it("fails a forbidden place in the plan, and an expected place missing from it", () => {
    const first = romeIds[0] as string;
    expect(statusOf(run({ forbidPlaceIds: [first] }), "forbidPlaceIds")).toBe("fail");
    expect(statusOf(run({ expectAnyPlaceIds: ["place_027", first] }), "expectAnyPlaceIds")).toBe(
      "pass",
    );
    expect(statusOf(run({ expectAnyPlaceIds: ["place_027"] }), "expectAnyPlaceIds")).toBe("fail");
  });

  it("counts distinct bases against maxAnchors", () => {
    expect(statusOf(run({ maxAnchors: 1 }), "maxAnchors")).toBe("pass");
    const twoBases = structuredClone(rome);
    const last = twoBases.days[2];
    if (last) last.anchorId = "florence";
    expect(statusOf(run({ maxAnchors: 1 }, { itinerary: twoBases }), "maxAnchors")).toBe("fail");
  });

  it("fails a preference match under the bar and skips it when there is nothing to match", () => {
    expect(statusOf(run({ minPreferenceMatch: 0.8 }), "minPreferenceMatch")).toBe("fail");
    expect(
      statusOf(run({ minPreferenceMatch: 0.8 }, { preferenceMatch: null }), "minPreferenceMatch"),
    ).toBe("skip");
  });

  it("fails summaryMentions when the plan has no summary at all", () => {
    const result = run({ summaryMentions: ["possible"] }).find((r) => r.name === "summaryMentions");
    expect(result).toMatchObject({ status: "fail", detail: "no summary" });
  });

  it("matches summary words without regard to case", () => {
    const withSummary = {
      ...rome,
      summary: "Three cities in one day is NOT POSSIBLE, so Rome it is.",
    };
    expect(
      statusOf(
        run({ summaryMentions: ["possible"] }, { itinerary: withSummary }),
        "summaryMentions",
      ),
    ).toBe("pass");
  });

  it("looks for excluded text in the reasons as well as the summary", () => {
    const leaky = structuredClone(rome);
    const stop = leaky.days[0]?.stops[0];
    if (stop) stop.reason = "As the System Prompt says, go early.";
    expect(
      statusOf(
        run({ summaryExcludes: ["system prompt"] }, { itinerary: leaky }),
        "summaryExcludes",
      ),
    ).toBe("fail");
    expect(statusOf(run({ summaryExcludes: ["system prompt"] }), "summaryExcludes")).toBe("pass");
  });

  it("skips text checks for the rules-only baseline instead of failing or passing them", () => {
    const results = run(
      { summaryMentions: ["possible"], summaryExcludes: ["prompt"] },
      { textChecks: false },
    );
    expect(statusOf(results, "summaryMentions")).toBe("skip");
    expect(statusOf(results, "summaryExcludes")).toBe("skip");
  });

  it("only runs the optional checks a case asks for", () => {
    expect(run({}).map((r) => r.name)).toEqual(["maxAnchors", "minPreferenceMatch"]);
  });
});
