import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Source guards for the whole planner package. The planner runs in the Lambda and in the
// browser, and every date in it is a calendar date in Italy. Two mistakes would break that
// silently: local-time Date methods (wrong weekday for travelers west of Italy) and Node-only
// imports (the web bundle breaks). These checks read the source so they fail in any time zone.

const SRC = fileURLToPath(new URL("../src", import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

/** Source text without comments, so a comment that names a method does not trip the guard. */
function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

// Decision: `new Date(...)` is allowed only as `new Date(Date.UTC(...))` or `new Date()`. Any other
// argument list is a local-time constructor (`new Date(y, m, d)`) or a string parse.
const LOCAL_TIME =
  /\.(get|set)(Day|Date|Month|FullYear|Hours|Minutes|Seconds|Milliseconds)\(|\.getTimezoneOffset\(|\.toLocale\w*\(|Date\.parse\(|new Date\((?!\s*\)|Date\.UTC\()/;
const NODE_ONLY = /from\s+["'](node:[\w/]+|fs|path|os|crypto|child_process|http|https|net)["'/]/;

describe("planner source guards", () => {
  const files = sourceFiles(SRC);

  it("finds the planner source files", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it("never uses local-time Date methods, so weekdays do not depend on the machine's time zone", () => {
    const offenders = files.filter((path) => LOCAL_TIME.test(code(path)));
    expect(offenders).toEqual([]);
  });

  it("never imports Node-only modules, so the same code runs in the browser", () => {
    const offenders = files.filter((path) => NODE_ONLY.test(code(path)));
    expect(offenders).toEqual([]);
  });

  it("contains no em dashes in source text", () => {
    const emDash = String.fromCharCode(0x2014);
    const offenders = files.filter((path) => readFileSync(path, "utf8").includes(emDash));
    expect(offenders).toEqual([]);
  });

  it("would catch a local-time weekday lookup or a local-time Date constructor", () => {
    expect(LOCAL_TIME.test("new Date(Date.UTC(y, m, d)).getDay()")).toBe(true);
    expect(LOCAL_TIME.test("new Date(Date.UTC(y, m, d)).getUTCDay()")).toBe(false);
    expect(LOCAL_TIME.test('new Date("2026-10-06")')).toBe(true);
    expect(LOCAL_TIME.test("new Date(year, month - 1, day).getUTCDay()")).toBe(true);
    expect(LOCAL_TIME.test("new Date(Date.UTC(year, month - 1, day)).getUTCDay()")).toBe(false);
    expect(NODE_ONLY.test('import { readFileSync } from "node:fs";')).toBe(true);
  });
});
