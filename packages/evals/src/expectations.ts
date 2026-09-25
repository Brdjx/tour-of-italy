import { type Itinerary, type PlannerContext, validateItinerary } from "@italy/planner";
import type { Expect } from "./cases";

// Per-case expectation checks (the "expect" block of a case file). Each check says pass, fail, or
// skip with a short detail, so the report can say which expectation a model missed.

export type CheckName = keyof Expect;

export interface CheckResult {
  name: CheckName;
  status: "pass" | "fail" | "skip";
  detail?: string; // what was found, for a failed check
}

export interface CheckInput {
  itinerary: Itinerary; // the plan the traveler would get
  rejectedCodes: readonly string[]; // error codes the model's answers had, as written or rejected
  preferenceMatch: number | null;
  textChecks: boolean; // false when no model wrote the summary (the rules-only baseline)
}

const pass = (name: CheckName): CheckResult => ({ name, status: "pass" });
const fail = (name: CheckName, detail: string): CheckResult => ({ name, status: "fail", detail });
const skip = (name: CheckName, detail: string): CheckResult => ({ name, status: "skip", detail });

function planIds(itinerary: Itinerary): Set<string> {
  return new Set(itinerary.days.flatMap((day) => day.stops.map((stop) => stop.placeId)));
}

/** Summary and reasons in lowercase, the text a traveler reads. */
function visibleText(itinerary: Itinerary): string {
  const reasons = itinerary.days.flatMap((day) => day.stops.map((stop) => stop.reason ?? ""));
  return [itinerary.summary ?? "", ...reasons].join("\n").toLowerCase();
}

function checkCodes(expect: Expect, input: CheckInput, ctx: PlannerContext): CheckResult[] {
  const out: CheckResult[] = [];
  const planCodes = validateItinerary(input.itinerary, ctx).map((v) => v.code);
  if (expect.forbidViolationCodes.length > 0) {
    // Decision: forbidden codes are looked for in the model's answers too, not only in the final
    // plan. Error codes can never reach the final plan (the pipeline tidies or replaces it), so
    // checking only the plan would always pass; the question is whether the model made the mistake.
    const seen = new Set([...planCodes, ...input.rejectedCodes]);
    const found = expect.forbidViolationCodes.filter((code) => seen.has(code));
    out.push(
      found.length === 0
        ? pass("forbidViolationCodes")
        : fail("forbidViolationCodes", found.join(", ")),
    );
  }
  if (expect.expectWarningCodes.length > 0) {
    const warned = new Set(input.itinerary.warnings.map((w) => w.code));
    const missing = expect.expectWarningCodes.filter((code) => !warned.has(code));
    out.push(
      missing.length === 0
        ? pass("expectWarningCodes")
        : fail("expectWarningCodes", `missing ${missing.join(", ")}`),
    );
  }
  return out;
}

function checkPlaces(expect: Expect, itinerary: Itinerary): CheckResult[] {
  const out: CheckResult[] = [];
  const ids = planIds(itinerary);
  if (expect.forbidPlaceIds.length > 0) {
    const found = expect.forbidPlaceIds.filter((id) => ids.has(id));
    out.push(
      found.length === 0 ? pass("forbidPlaceIds") : fail("forbidPlaceIds", found.join(", ")),
    );
  }
  if (expect.expectAnyPlaceIds.length > 0) {
    const hit = expect.expectAnyPlaceIds.some((id) => ids.has(id));
    out.push(hit ? pass("expectAnyPlaceIds") : fail("expectAnyPlaceIds", "none of them planned"));
  }
  return out;
}

function checkText(expect: Expect, input: CheckInput): CheckResult[] {
  const out: CheckResult[] = [];
  const why = "the rules-only planner writes no summary";
  if (expect.summaryMentions.length > 0) {
    if (!input.textChecks) out.push(skip("summaryMentions", why));
    else {
      const summary = (input.itinerary.summary ?? "").toLowerCase();
      const missing = expect.summaryMentions.filter(
        (word) => !summary.includes(word.toLowerCase()),
      );
      out.push(
        missing.length === 0
          ? pass("summaryMentions")
          : fail(
              "summaryMentions",
              summary === "" ? "no summary" : `missing ${missing.join(", ")}`,
            ),
      );
    }
  }
  if (expect.summaryExcludes.length > 0) {
    if (!input.textChecks) out.push(skip("summaryExcludes", why));
    else {
      const text = visibleText(input.itinerary);
      const found = expect.summaryExcludes.filter((word) => text.includes(word.toLowerCase()));
      out.push(
        found.length === 0 ? pass("summaryExcludes") : fail("summaryExcludes", found.join(", ")),
      );
    }
  }
  return out;
}

/** Every check the case asks for, in the order of the expect block. */
export function checkExpectations(
  expect: Expect,
  input: CheckInput,
  ctx: PlannerContext,
): CheckResult[] {
  const anchors = new Set(input.itinerary.days.map((day) => day.anchorId)).size;
  const out: CheckResult[] = [
    anchors <= expect.maxAnchors ? pass("maxAnchors") : fail("maxAnchors", `${anchors} bases`),
  ];
  const match = input.preferenceMatch;
  if (match === null) out.push(skip("minPreferenceMatch", "no interests or no visits"));
  else if (match >= expect.minPreferenceMatch) out.push(pass("minPreferenceMatch"));
  else out.push(fail("minPreferenceMatch", `${Math.round(match * 100)}%`));
  out.push(...checkCodes(expect, input, ctx));
  out.push(...checkPlaces(expect, input.itinerary));
  out.push(...checkText(expect, input));
  return out;
}
