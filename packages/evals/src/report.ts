import type { EvalCase } from "./cases";
import { decimal, minutes, NA, percent, ratio, seconds, table, tokens, usd } from "./format";
import { PRICING_CHECKED_ON, PRICING_SOURCE } from "./pricing";
import type { ReplayedGroup } from "./replayRun";
import type { Summary } from "./summary";

// Renders results/latest.md: the comparison across models and the rules-only baseline, per-case
// pass or fail, the guardrail recordings, and stale recordings. Pure and deterministic: the same
// recordings and code always give the same file, so it only changes in git when a number does.

export interface ReportInput {
  cases: readonly EvalCase[];
  groups: readonly ReplayedGroup[]; // replayed recordings, adversarial included
  baseline: Summary; // the rules-only planner on every case
}

interface Column {
  title: string;
  summary: Summary;
  role: "live" | "simulated" | "baseline";
}

function columnsOf(input: ReportInput): Column[] {
  const models = input.groups
    .filter((g) => g.kind !== "adversarial")
    .map((g): Column => {
      if (g.kind === "simulated") {
        return { title: "Simulated (not a model)", summary: g.summary, role: "simulated" };
      }
      const when = g.recordedOn === null ? "" : `, recorded ${g.recordedOn}`;
      return { title: `${g.model} (${g.promptVersion}${when})`, summary: g.summary, role: "live" };
    });
  return [...models, { title: "Rules-only baseline", summary: input.baseline, role: "baseline" }];
}

type Row = [label: string, cell: (s: Summary, role: Column["role"]) => string];

const modelOnly = (role: Column["role"], text: () => string) => (role === "baseline" ? NA : text());
const liveOnly = (role: Column["role"], text: () => string) => (role === "live" ? text() : NA);

function count(rateValue: number | null, whole: number): string {
  return rateValue === null ? NA : ratio(Math.round(rateValue * whole), whole);
}

function reasonsText(s: Summary): string {
  const entries = Object.entries(s.fallbackReasons);
  return entries.length === 0 ? "none" : entries.map(([r, n]) => `${r} ${n}`).join(", ");
}

/** "20% (29/144): 0 none open, 29 not planned". */
function mealGapText(s: Summary): string {
  if (s.days === 0) return NA;
  const notPlanned = s.mealGapDays - s.noneOpenDays;
  return `${ratio(s.mealGapDays, s.days)}: ${s.noneOpenDays} none open, ${notPlanned} not planned`;
}

function casesPassedText(s: Summary): string {
  const passed = `${s.casesPassed}/${s.cases.length}`;
  const skips = s.casesPassedWithSkips;
  return skips === 0 ? passed : `${passed} (${skips} with a check not run)`;
}

const ROWS: Row[] = [
  ["Plans", (s) => String(s.plans)],
  ["First-pass valid", (s, r) => modelOnly(r, () => count(s.firstPassValidRate, s.answeredPlans))],
  [
    "Valid after tidying, no repair",
    (s, r) => modelOnly(r, () => count(s.validAfterTidyRate, s.answeredPlans)),
  ],
  ["Final valid (must be 100%)", (s) => count(s.finalValidRate, s.plans)],
  ["Needed a repair", (s, r) => modelOnly(r, () => count(s.repairRate, s.answeredPlans))],
  ["Repairs that worked", (s, r) => modelOnly(r, () => percent(s.repairSuccessRate))],
  ["Fell back to rules-only", (s, r) => modelOnly(r, () => count(s.fallbackRate, s.plans))],
  ["Fallback reasons", (s, r) => modelOnly(r, () => reasonsText(s))],
  ["Preference match", (s) => percent(s.preferenceMatch)],
  ["Must-includes placed", (s) => percent(s.mustIncludeRate)],
  ["Visits per day", (s) => `${decimal(s.visitsPerDay)} (${percent(s.paceFill)} of pace cap)`],
  ["Travel per day", (s) => minutes(s.travelMinPerDay)],
  ["Transfer time per trip", (s) => minutes(s.transferMinPerTrip)],
  ["Days missing a lunch or dinner", (s) => mealGapText(s)],
  [
    "Days missing a meal before code added one",
    (s, r) =>
      modelOnly(r, () => (s.mealGapBeforeDays === null ? NA : ratio(s.mealGapBeforeDays, s.days))),
  ],
  ["Lunches and dinners code added", (s, r) => modelOnly(r, () => String(s.mealsAdded))],
  [
    "Model time p50 / p95",
    (s, r) => liveOnly(r, () => `${seconds(s.latencyP50Ms)} / ${seconds(s.latencyP95Ms)}`),
  ],
  ["Slowest model time", (s, r) => liveOnly(r, () => seconds(s.latencyMaxMs))],
  [
    "Tokens in / out per plan",
    (s, r) => liveOnly(r, () => `${tokens(s.avgInputTokens)} / ${tokens(s.avgOutputTokens)}`),
  ],
  ["Estimated cost per plan", (s, r) => (r === "simulated" ? NA : usd(s.avgCostUsd))],
  ["Cases meeting every expectation", (s) => casesPassedText(s)],
  ["Stale recordings", (s, r) => (r === "baseline" ? NA : String(s.stalePlans))],
];

function comparison(columns: readonly Column[]): string[] {
  const head = ["Metric", ...columns.map((c) => c.title)];
  const rows = ROWS.map(([label, cell]) => [label, ...columns.map((c) => cell(c.summary, c.role))]);
  return ["## Comparison", "", ...table(head, rows)];
}

function caseCell(summary: Summary, caseId: string): string {
  const totals = summary.cases.find((c) => c.caseId === caseId);
  if (totals === undefined) return NA;
  const runs = totals.runs === 1 ? "" : `${totals.passedRuns}/${totals.runs} `;
  if (totals.passedRuns === totals.runs) {
    const unchecked = totals.skippedChecks;
    return unchecked.length === 0
      ? `${runs}pass`
      : `${runs}pass (not run: ${unchecked.join(", ")})`;
  }
  return `${runs}fail: ${totals.failedChecks.join(", ")}`;
}

function caseTable(cases: readonly EvalCase[], columns: readonly Column[]): string[] {
  const head = ["Case", "What it checks", ...columns.map((c) => c.title)];
  const rows = cases.map((c) => [
    c.id,
    c.description,
    ...columns.map((col) => caseCell(col.summary, c.id)),
  ]);
  return ["## Cases", "", ...table(head, rows)];
}

function guardrails(groups: readonly ReplayedGroup[]): string[] {
  const scenarios = groups.filter((g) => g.kind === "adversarial").flatMap((g) => g.scenarios);
  if (scenarios.length === 0) return [];
  const rows = scenarios.map((s) => [
    s.name,
    s.caseId,
    s.expected,
    s.asExpected ? s.got : `${s.got} (unexpected${s.stale ? ", stale recording" : ""})`,
    s.finalValid ? "yes" : "NO",
  ]);
  return [
    "## Guardrail recordings",
    "",
    "Hand-written bad answers (not model output) replayed through the pipeline. Each must end in a",
    "valid plan by the path named in Expected.",
    "",
    ...table(["Answer", "Case", "Expected", "Got", "Valid plan"], rows),
  ];
}

function staleSection(groups: readonly ReplayedGroup[]): string[] {
  const lines = groups.flatMap((g) =>
    g.stale.map(
      (s) =>
        `- ${g.kind === "live" ? g.model : g.kind}: ${s.caseId} run ${s.run} (${s.reasons.join(", ")})`,
    ),
  );
  // A run that needs more calls, or other calls, than were recorded no longer follows its
  // recording; both counts say how far the current pipeline has moved from it.
  const missing = groups.reduce((sum, g) => sum + g.missingCalls, 0);
  const mismatched = groups.reduce((sum, g) => sum + g.turnMismatches, 0);
  const intro =
    "A stale recording was made against a different candidate list or request than today's. It is still replayed; the validator must still catch whatever no longer fits.";
  return [
    "## Stale recordings",
    "",
    intro,
    "",
    ...(lines.length === 0 ? ["None."] : lines),
    ...(missing === 0
      ? []
      : ["", `Calls the pipeline made that no recording answered: ${missing}.`]),
    ...(mismatched === 0
      ? []
      : [
          "",
          `Calls answered by a recording of the other turn (first answer or repair): ${mismatched}.`,
        ]),
  ];
}

function banner(columns: readonly Column[], caseCount: number): string[] {
  if (columns.some((c) => c.role === "live")) {
    const partial = columns.filter((c) => c.role === "live" && c.summary.cases.length < caseCount);
    const note =
      partial.length === 0
        ? []
        : [
            "",
            `Not every model ran every case (${partial.map((c) => c.title).join("; ")}), so compare those columns case by case.`,
          ];
    return [
      "Live model answers, replayed through the current code. Model time, tokens, and cost are as recorded.",
      ...note,
    ];
  }
  return [
    "> No live model runs are recorded yet. The Simulated column is a scripted client, not a model:",
    "> it reruns the rules-only planner on the model's shortlist and, when the traveler lets the",
    "> planner choose, takes the first two bases offered. It proves the pipeline works end to end;",
    "> it says nothing about how Claude plans, so it has no time, token, or cost numbers. Where it",
    "> differs from the baseline (preference match, travel, transfers), the cause is that base",
    "> choice and the shorter candidate list, not a model.",
  ];
}

const NOTES = [
  "## How to read this",
  "",
  "- First-pass valid: the model's first answer became the plan exactly as written, with nothing tidied, no meal added and no repair. Valid after tidying: the first answer became the plan, tidied or not, with no repair turn and no fallback. Final valid: the plan the traveler gets has no validator errors. Only final valid blocks CI.",
  "- Preference match: share of non-meal stops with at least one requested interest. Must-includes placed: in the model's first answer (in the plan, for the baseline), since the final plan always has them.",
  "- A check that cannot apply is not run, and a case passed without it says so: the rules-only planner writes no summary, so its summary checks are never run, while a model column must pass them.",
  "- Travel per day: legs between stops and back to the base. Transfer time: moving between bases.",
  "- Days missing a lunch or dinner: days the validator warns have no lunch or no dinner stop (MEAL_MISSING), over all days of all plans. An outing that runs through a meal counts as that meal. None open: no place of the city that the traveler does not avoid could take the meal that date (in this data, Bologna's lunch on Sundays and dinner on Mondays), so only another city could feed the day; not planned: a place could.",
  "- Days missing a meal before code added one: the same count on each answer as it passed the check. Code then adds a lunch or dinner a day lacks where the rules-only planner's meal fill seats a place the model was offered without moving any of its stops, and the plan becomes ai_repaired (decision 17). Lunches and dinners code added: how many, over all plans.",
  "- Model time: the recorded call times of a plan, failed and timed-out calls included, summed. p50 is the median plan, p95 the nearest-rank 95th percentile, slowest the one slowest plan. The end-to-end latency of a live run is in its results file.",
  `- Costs are estimates from prices checked on ${PRICING_CHECKED_ON}. Check ${PRICING_SOURCE} before quoting them.`,
  "- Regenerate with `pnpm eval:replay` (offline). Record live answers with `pnpm eval --model <id>`.",
];

export function renderReport(input: ReportInput): string {
  const columns = columnsOf(input);
  const sections = [
    [
      "# Eval results",
      "",
      "Generated by the eval harness. Do not edit by hand.",
      "",
      ...banner(columns, input.cases.length),
    ],
    comparison(columns),
    caseTable(input.cases, columns),
    guardrails(input.groups),
    staleSection(input.groups),
    NOTES,
  ].filter((lines) => lines.length > 0);
  return `${sections.map((lines) => lines.join("\n")).join("\n\n")}\n`;
}
