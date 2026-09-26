import { describe, expect, it } from "vitest";
import type { PlanShape } from "../src/metrics";
import type { ReplayedGroup } from "../src/replayRun";
import { renderReport } from "../src/report";
import { summarize } from "../src/summary";
import { caseById, measure } from "./helpers";

// latest.md is what people read and what the write-up quotes. It must never pass simulated
// numbers off as model behavior, never show a zero where a number does not apply, and never
// change unless a number did.

const cases = [caseById("rome-food-balanced"), caseById("splurge")];

function group(kind: ReplayedGroup["kind"], overrides: Partial<ReplayedGroup> = {}): ReplayedGroup {
  const measures = [
    measure({
      caseId: "rome-food-balanced",
      latencyMs: 6000,
      inputTokens: 5000,
      outputTokens: 800,
      costUsd: 0.018,
      // Two days missed a meal as the model wrote them: code added three meals and fed one of
      // them; the other had no place open.
      shape: { ...(measure().shape as PlanShape), daysMissingMeal: 1, daysNoneOpen: 1 },
      mealsAdded: 3,
      daysMissingMealBefore: 2,
    }),
    measure({
      caseId: "splurge",
      source: "deterministic",
      fallbackReason: "timeout",
      firstPassValid: false,
      latencyMs: 12000,
      inputTokens: 5000,
      outputTokens: 0,
      costUsd: 0.01,
      checks: [{ name: "summaryMentions", status: "fail", detail: "no summary" }],
    }),
  ];
  return {
    kind,
    model: kind === "live" ? "claude-sonnet-5" : kind,
    promptVersion: "v1",
    recordedOn: kind === "live" ? "2026-09-30" : null,
    runsPerCase: 1,
    measures,
    summary: summarize(measures),
    stale: [],
    scenarios: [],
    missingCalls: 0,
    turnMismatches: 0,
    ...overrides,
  };
}

const baseline = summarize([
  measure({
    caseId: "rome-food-balanced",
    source: "deterministic",
    answered: false,
    firstPassValid: false,
    costUsd: 0,
  }),
  measure({
    caseId: "splurge",
    source: "deterministic",
    answered: false,
    firstPassValid: false,
    costUsd: 0,
  }),
]);

function rowOf(markdown: string, label: string): string {
  return markdown.split("\n").find((line) => line.startsWith(`| ${label} |`)) ?? "";
}

describe("latest.md", () => {
  it("says plainly that simulated numbers are not model behavior, and gives them no time or cost", () => {
    const md = renderReport({ cases, groups: [group("simulated")], baseline });
    expect(md).toContain("No live model runs are recorded yet");
    expect(md).toContain("| Metric | Simulated (not a model) | Rules-only baseline |");
    // Its plans are not the baseline's: it picks the first two offered bases, and says so.
    expect(md).toContain("takes the first two bases offered");
    expect(md).toContain(
      "the cause is that base\n> choice and the shorter candidate list, not a model.",
    );
    expect(md).not.toContain("own choices");
    expect(rowOf(md, "Model time p50 / p95")).toBe("| Model time p50 / p95 | n/a | n/a |");
    expect(rowOf(md, "Slowest model time")).toBe("| Slowest model time | n/a | n/a |");
    expect(rowOf(md, "Estimated cost per plan")).toBe("| Estimated cost per plan | n/a | $0 |");
  });

  it("shows a live model beside the baseline with its time, tokens, cost, and fallbacks", () => {
    const md = renderReport({ cases, groups: [group("live")], baseline });
    expect(md).not.toContain("No live model runs");
    expect(md).toContain("claude-sonnet-5 (v1, recorded 2026-09-30)");
    expect(rowOf(md, "Model time p50 / p95")).toContain("6.0 s / 12.0 s");
    expect(rowOf(md, "Tokens in / out per plan")).toContain("5,000 / 400");
    expect(rowOf(md, "Estimated cost per plan")).toContain("$0.0140");
    expect(rowOf(md, "Fell back to rules-only")).toContain("50% (1/2)");
    expect(rowOf(md, "Fallback reasons")).toContain("timeout 1");
    expect(rowOf(md, "First-pass valid")).toBe("| First-pass valid | 50% (1/2) | n/a |");
    expect(rowOf(md, "Valid after tidying, no repair")).toBe(
      "| Valid after tidying, no repair | 50% (1/2) | n/a |",
    );
    expect(rowOf(md, "Slowest model time")).toBe("| Slowest model time | 12.0 s | n/a |");
    expect(rowOf(md, "Days missing a lunch or dinner")).toBe(
      "| Days missing a lunch or dinner | 17% (1/6): 1 none open, 0 not planned | 0% (0/6): 0 none open, 0 not planned |",
    );
    expect(rowOf(md, "Days missing a meal before code added one")).toBe(
      "| Days missing a meal before code added one | 33% (2/6) | n/a |",
    );
    expect(rowOf(md, "Lunches and dinners code added")).toBe(
      "| Lunches and dinners code added | 3 | n/a |",
    );
  });

  it("warns when a model ran only some of the cases, so its totals are not compared blindly", () => {
    const partial = renderReport({
      cases: [...cases, caseById("everything")],
      groups: [group("live")],
      baseline,
    });
    expect(partial).toContain("Not every model ran every case (claude-sonnet-5");
    expect(renderReport({ cases, groups: [group("live")], baseline })).not.toContain(
      "Not every model",
    );
  });

  it("puts two models side by side when both have been run", () => {
    const haiku = group("live", { model: "claude-haiku-4-5-20251001" });
    const md = renderReport({ cases, groups: [group("live"), haiku], baseline });
    expect(md).toContain(
      "| Metric | claude-sonnet-5 (v1, recorded 2026-09-30) | claude-haiku-4-5-20251001 (v1, recorded 2026-09-30) | Rules-only baseline |",
    );
  });

  it("never shows the baseline passing a case on a check it could not run", () => {
    const unchecked = summarize([
      measure({
        caseId: "splurge",
        source: "deterministic",
        answered: false,
        checks: [{ name: "summaryMentions", status: "skip", detail: "no summary" }],
      }),
      measure({ caseId: "rome-food-balanced", source: "deterministic", answered: false }),
    ]);
    const md = renderReport({ cases, groups: [group("live")], baseline: unchecked });
    expect(rowOf(md, "splurge")).toContain(
      "| fail: summaryMentions | pass (not run: summaryMentions) |",
    );
    expect(rowOf(md, "Cases meeting every expectation")).toBe(
      "| Cases meeting every expectation | 1/2 | 2/2 (1 with a check not run) |",
    );
  });

  it("labels time between bases as time, not as a count of transfers", () => {
    const md = renderReport({ cases, groups: [group("live")], baseline });
    expect(rowOf(md, "Transfer time per trip")).toBe("| Transfer time per trip | 0 min | 0 min |");
    expect(md).not.toContain("Transfers per trip");
  });

  it("names the failed checks of each case per column", () => {
    const md = renderReport({ cases, groups: [group("live")], baseline });
    expect(rowOf(md, "splurge")).toContain("| fail: summaryMentions | pass |");
    expect(rowOf(md, "rome-food-balanced")).toContain("| pass | pass |");
  });

  it("lists guardrail recordings and flags one that ended unexpectedly", () => {
    const adversarial = group("adversarial", {
      scenarios: [
        {
          caseId: "splurge",
          name: "Refusal",
          note: "n",
          expected: "deterministic (refusal)",
          got: "ai",
          asExpected: false,
          finalValid: true,
          stale: false,
        },
      ],
    });
    const md = renderReport({ cases, groups: [group("simulated"), adversarial], baseline });
    expect(md).toContain("| Refusal | splurge | deterministic (refusal) | ai (unexpected) | yes |");
    // Guardrail answers never become a comparison column.
    expect(md).not.toContain("| adversarial");
  });

  it("lists stale recordings with the reason, and calls that no longer follow their recording", () => {
    const stale = group("live", {
      stale: [{ caseId: "splurge", run: 2, reasons: ["candidates changed"] }],
      missingCalls: 1,
      turnMismatches: 2,
    });
    const md = renderReport({ cases, groups: [stale], baseline });
    expect(md).toContain("- claude-sonnet-5: splurge run 2 (candidates changed)");
    expect(md).toContain("no recording answered: 1.");
    expect(md).toContain("of the other turn (first answer or repair): 2.");
  });

  it("is plain text a table cannot break, with no em dashes, and the same every time", () => {
    const piped = { ...caseById("splurge"), description: "Food | scenery" };
    const input = { cases: [piped], groups: [group("simulated")], baseline };
    const md = renderReport(input);
    expect(md).toContain("Food \\| scenery");
    expect(md).not.toContain(String.fromCharCode(0x2014)); // the em dash
    expect(renderReport(input)).toBe(md);
  });
});
