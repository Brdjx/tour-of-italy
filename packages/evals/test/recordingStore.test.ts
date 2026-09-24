import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PROMPT_VERSION } from "@italy/api/llm/prompt";
import { describe, expect, it } from "vitest";
import { PATHS } from "../src/paths";
import { clearRecordings, replaceCaseRecordings } from "../src/recordingStore";
import { Scrubber } from "../src/scrub";
import { tempDir } from "./helpers";

// Recordings are committed, and a paid live run cannot be repeated for free. Clearing and
// replacing them must touch exactly one kind, model, and case, and nothing when a write is refused.

const ADVERSARIAL = join(PATHS.recordings, "adversarial", PROMPT_VERSION);

/** A copy of the committed adversarial folder in a temporary recordings root. */
function copyOfAdversarialSet(): { dir: string; folder: string; names: string[] } {
  const dir = tempDir();
  const folder = join(dir, "adversarial", PROMPT_VERSION);
  mkdirSync(folder, { recursive: true });
  const names = readdirSync(ADVERSARIAL).sort();
  for (const name of names) copyFileSync(join(ADVERSARIAL, name), join(folder, name));
  return { dir, folder, names };
}

describe("clearing recordings", () => {
  it("never deletes an offline set's files when clearing a live model's files in the same folder", () => {
    const { dir, folder, names } = copyOfAdversarialSet();
    const live = { kind: "live" as const, model: "adversarial", promptVersion: PROMPT_VERSION };
    expect(clearRecordings(dir, live, ["splurge", "family-quiet"])).toBe(0);
    expect(readdirSync(folder).sort()).toEqual(names);
  });

  it("clears only the named case of the named kind", () => {
    const { dir, folder, names } = copyOfAdversarialSet();
    const target = { kind: "adversarial" as const, model: "adversarial", promptVersion: "v1" };
    expect(clearRecordings(dir, target, ["splurge"])).toBe(2);
    expect(readdirSync(folder).sort()).toEqual(names.filter((n) => !n.startsWith("splurge-")));
  });
});

describe("replacing a case's recordings", () => {
  it("leaves the previous recordings in place when a new one is refused for holding a secret", () => {
    const { dir, folder, names } = copyOfAdversarialSet();
    const target = { kind: "adversarial" as const, model: "adversarial", promptVersion: "v1" };
    const key = "sk-live-planted-secret-value";
    // A scrubber that removes nothing lets the key through to the final check, which refuses.
    class NoScrubbing extends Scrubber {
      override value<T>(value: T): T {
        return value;
      }
    }
    const leaky = new NoScrubbing([key]);
    const bad = {
      format: 1 as const,
      kind: "adversarial" as const,
      caseId: "splurge",
      run: 1,
      attempt: 1,
      turn: "select" as const,
      model: "adversarial",
      promptVersion: "v1",
      recordedAt: "2026-09-24T12:00:00.000Z",
      candidateHash: `sha256:${"0".repeat(64)}`,
      request: {
        startDate: "2026-05-12",
        pace: "balanced" as const,
        interests: [],
        maxPriceLevel: null,
        anchors: "auto" as const,
        mustInclude: [],
        exclude: [],
      },
      error: { kind: "auth" as const, message: `rejected ${key}` },
    };
    expect(() => replaceCaseRecordings(dir, target, "splurge", [bad], leaky)).toThrow(
      /Refusing to write/,
    );
    expect(readdirSync(folder).sort()).toEqual(names);
  });
});
