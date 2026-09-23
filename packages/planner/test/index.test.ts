import { describe, expect, it } from "vitest";
import { version } from "../src/index";

describe("planner package", () => {
  it("exports a semver version string", () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
