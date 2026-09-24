import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";
import { alternativesFor, moveStop, removeStop, rescheduleDay } from "../../src/alternatives";
import { compareViolations } from "../../src/plan";
import type { Violation } from "../../src/types";
import { validateItinerary } from "../../src/validate";
import { anyTripRequest, ctx, PROPERTY_SETTINGS, requestAndPick, seedLine } from "./arbitraries";
import { hardRuleProblems } from "./hardRules";
import { anyEdit, applyEdits, EDIT_NAMES, editNames } from "./perturbations";
import { planFor } from "./planMemo";
import { swapProblems } from "./swapChecks";
import { sharedKeys } from "./violationKeys";

// Everything that happens to a plan after planDeterministic returns it: the swap button, a
// remove or reorder in the browser, and drift from a buggy client or a tampered request. One
// file so every property reuses the same memoized plans (planMemo.ts).
// F1: a swap the web app applies without a further check must never make the plan invalid, and
// the validator (the last gate) must never accept an impossible edited plan.
// F10: after an edit, the browser's problems and warnings must be exactly the validator's.

const TIMEOUT_MS = 60_000 + PROPERTY_SETTINGS.numRuns * 150;

/** An upper bound on candidates, so one call returns every alternative the base allows. */
const EVERY_CANDIDATE = 1000;

describe("plans after they are made: swaps, edits, and drift", () => {
  beforeAll(() => {
    console.info(seedLine("planEdits"));
  });

  it(
    "never offers a swap, at any stop of any planned trip, that leaves the plan invalid",
    () => {
      let offered = 0;
      fc.assert(
        fc.property(anyTripRequest, (request) => {
          const itinerary = planFor(request);
          const problems: string[] = [];
          itinerary.days.forEach((day, d) => {
            day.stops.forEach((_stop, s) => {
              for (const alternative of alternativesFor(itinerary, d, s, ctx)) {
                offered++;
                problems.push(...swapProblems(itinerary, d, s, alternative));
              }
            });
          });
          expect(problems).toEqual([]);
        }),
        PROPERTY_SETTINGS,
      );
      // Not vacuous: on average every trip offered more than one swap.
      expect(offered).toBeGreaterThan(PROPERTY_SETTINGS.numRuns);
    },
    TIMEOUT_MS,
  );

  it(
    "never ranks in, beyond the five shown, a candidate that would leave the plan invalid",
    () => {
      fc.assert(
        fc.property(requestAndPick, ({ request, day, stop }) => {
          const itinerary = planFor(request);
          const d = day % itinerary.days.length;
          const stops = itinerary.days[d]?.stops ?? [];
          if (stops.length === 0) return;
          const s = stop % stops.length;
          const all = alternativesFor(itinerary, d, s, ctx, EVERY_CANDIDATE);
          const problems = all.flatMap((alternative) => swapProblems(itinerary, d, s, alternative));
          expect(problems).toEqual([]);
          const ids = all.map((alternative) => alternative.place.id);
          expect(new Set(ids).size).toBe(ids.length);
          expect(alternativesFor(itinerary, d, s, ctx).map((a) => a.place.id)).toEqual(
            ids.slice(0, 5),
          );
        }),
        PROPERTY_SETTINGS,
      );
    },
    TIMEOUT_MS,
  );

  it(
    "never shows other warnings or errors after a remove or reorder than the validator gives",
    () => {
      fc.assert(
        fc.property(requestAndPick, fc.nat(), ({ request, day, stop }, to) => {
          const itinerary = planFor(request);
          const d = day % itinerary.days.length;
          const plan = itinerary.days[d];
          if (!plan || plan.stops.length < 2) return;
          const s = stop % plan.stops.length;
          const ids =
            to % 2 === 0 ? removeStop(plan, s) : moveStop(plan, s, to % plan.stops.length);
          const edited = rescheduleDay(itinerary, d, ids, ctx);
          const verdict = validateItinerary(edited.itinerary, ctx);
          const warnings = verdict.filter((v) => v.severity === "warning").sort(compareViolations);
          expect(edited.itinerary.warnings).toEqual(warnings);
          // The edited day's errors, by meaning: both sides must flag the same stops.
          const errors = (list: Violation[]) =>
            sharedKeys(list.filter((v) => v.severity === "error" && v.day === d));
          expect(errors(edited.violations)).toEqual(errors(verdict));
        }),
        PROPERTY_SETTINGS,
      );
    },
    TIMEOUT_MS,
  );

  it(
    "never accepts an edited plan that breaks a hard rule, and never rejects one that keeps them",
    () => {
      const applied = new Set<string>();
      const outcomes = { accepted: 0, rejected: 0 };
      fc.assert(
        fc.property(anyTripRequest, fc.array(anyEdit, { minLength: 1, maxLength: 3 }), (r, e) => {
          const plan = applyEdits(planFor(r), e);
          for (const name of editNames(e)) applied.add(name);
          // Must-include placement is a trip-level judgment the re-check does not make.
          const errors = validateItinerary(plan, ctx)
            .filter((v) => v.severity === "error" && v.code !== "MUST_INCLUDE_MISSING")
            .map((v) => `${v.code} day ${v.day ?? "-"} stop ${v.stopIndex ?? "-"}`);
          const problems = hardRuleProblems(plan, ctx);
          if (problems.length === 0) outcomes.accepted++;
          else outcomes.rejected++;
          expect({ edits: editNames(e), accepts: errors.length === 0, errors, problems }).toEqual({
            edits: editNames(e),
            accepts: problems.length === 0,
            errors,
            problems,
          });
        }),
        PROPERTY_SETTINGS,
      );
      // Not vacuous: every edit kind ran, and both verdicts occurred many times.
      expect([...applied].sort()).toEqual([...EDIT_NAMES].sort());
      expect(outcomes.accepted).toBeGreaterThan(PROPERTY_SETTINGS.numRuns / 20);
      expect(outcomes.rejected).toBeGreaterThan(PROPERTY_SETTINGS.numRuns / 4);
    },
    TIMEOUT_MS,
  );
});
