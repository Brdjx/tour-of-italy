import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL, DEFAULT_RUNS, parseArgs } from "../src/args";

// A mistyped flag must stop the run before it spends tokens, never fall back to a default.

describe("pnpm eval options", () => {
  it("defaults to Sonnet 5, three runs, every case", () => {
    expect(parseArgs([])).toEqual({ model: DEFAULT_MODEL, runs: DEFAULT_RUNS, cases: [] });
    expect(DEFAULT_MODEL).toBe("claude-sonnet-5");
  });

  it("reads both flag forms, repeated and comma-separated case filters, and a pnpm separator", () => {
    const args = [
      "--",
      "--model=claude-haiku-4-5-20251001",
      "--runs",
      "2",
      "--case",
      "rome,lake",
      "--case=splurge",
    ];
    expect(parseArgs(args)).toEqual({
      model: "claude-haiku-4-5-20251001",
      runs: 2,
      cases: ["rome", "lake", "splurge"],
    });
  });

  it.each([
    [["--runs", "0"], /from 1 to 10/],
    [["--runs", "11"], /from 1 to 10/],
    [["--runs", "2.5"], /from 1 to 10/],
    [["--runs"], /needs a value/],
    [["--model", "--runs", "2"], /needs a value/],
    [["--model", "Claude Sonnet"], /Not a model id/],
    [["--modle", "x"], /Unknown option: --modle/],
  ])("refuses %j", (argv, message) => {
    expect(() => parseArgs(argv)).toThrow(message);
  });

  it.each(["simulated", "adversarial"])(
    "refuses --model %s, whose live run would replace the committed offline set of that name",
    (model) => {
      expect(() => parseArgs(["--model", model])).toThrow(/offline recording set/);
    },
  );
});
