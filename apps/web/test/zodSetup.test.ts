// @vitest-environment node
import "../lib/zodSetup";
import { readFileSync } from "node:fs";
import { ItinerarySchema } from "@italy/planner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { fixturePlan } from "./fixtures";

// Zod 4 probes `new Function` unless it is jitless, and the site's CSP reports that probe as a
// violation on every page load. The setting must be in place before any schema is built.

afterEach(() => vi.unstubAllGlobals());

describe("zodSetup", () => {
  it("turns off Zod's compiled parsers", () => {
    expect(z.config().jitless).toBe(true);
  });

  it("parses the planner's schemas without ever calling Function (no CSP eval report)", () => {
    const calls: unknown[] = [];
    const RealFunction = Function;
    vi.stubGlobal(
      "Function",
      new Proxy(RealFunction, {
        construct(target, args) {
          calls.push(args);
          return Reflect.construct(target, args);
        },
        apply(target, self, args) {
          calls.push(args);
          return Reflect.apply(target, self, args);
        },
      }),
    );
    expect(ItinerarySchema.safeParse(fixturePlan()).success).toBe(true);
    expect(calls).toEqual([]);
  });

  it("is the page's first import, before anything that builds a schema", () => {
    const source = readFileSync(new URL("../components/PlannerApp.tsx", import.meta.url), "utf8");
    const imports = source.split("\n").filter((line) => line.startsWith("import "));
    expect(imports[0]).toBe('import "../lib/zodSetup";');
  });
});
