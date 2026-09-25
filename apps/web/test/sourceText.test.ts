import { FALLBACK_REASONS } from "@italy/planner";
import { describe, expect, it } from "vitest";
import { fromBase64Url, toBase64Url } from "../lib/base64url";
import { CAUSE_TEXT, FALLBACK_TEXT, sourceText } from "../lib/sourceText";
import { aiPlan, fixturePlan } from "./fixtures";

const EM_DASH = String.fromCharCode(0x2014);

// The source badge is the product's honesty: it must never claim AI for a rules plan, and every
// fallback reason needs plain words.

describe("sourceText", () => {
  it("says who planned it for every source", () => {
    const ai = aiPlan();
    expect(sourceText(ai, "api").label).toBe("Planned with AI, checked against hours and distance");
    expect(sourceText({ ...ai, source: "ai_repaired" }, "api").label).toBe(
      "Planned with AI, fixed after a check",
    );
    expect(sourceText(fixturePlan(), "api").label).toBe("Planned without AI");
    expect(sourceText(ai, "shared").label).toBe("Shared plan, checked against hours and distance");
  });

  it("names both ways a draft is fixed, since the server may tidy it without asking the AI", () => {
    const [first] = sourceText({ ...aiPlan(), source: "ai_repaired" }, "api").details;
    expect(first).toContain("first draft broke a rule");
    expect(first).toContain("dropped or reordered stops, or asked the AI");
  });

  it("labels a browser-built plan offline only when the server could not be reached", () => {
    const plan = fixturePlan();
    expect(sourceText(plan, "offline", { cause: "offline" })).toMatchObject({
      label: "Planned without AI, offline",
      offline: true,
      marker: "rules",
    });
    // Restored from storage without a cause: honest about where, silent about why.
    expect(sourceText(plan, "offline")).toMatchObject({
      label: "Planned without AI, on this device",
      offline: false,
    });
  });

  it.each([
    ["timeout", "did not answer in time"],
    ["busy", "is busy right now"],
    ["server", "had an error"],
    ["unreadable", "sent a reply this page cannot read"],
    ["invalid", "did not pass the checks on this device"],
  ] as const)("never says offline when the service answered (%s)", (cause, words) => {
    const text = sourceText(fixturePlan(), "offline", { cause });
    expect(text.label).toBe("Planned without AI, on this device");
    expect(text.offline).toBe(false);
    expect(text.details[0]).toContain(words);
    expect(text.details[0]).not.toContain("could not be reached");
    expect(CAUSE_TEXT[cause]).toBe(text.details[0]);
  });

  it("stops claiming 'checked' when the current plan breaks a rule", () => {
    const edited = sourceText(aiPlan(), "api", { errors: 2, edited: true });
    expect(edited.label).toBe("Edited by you, 2 problems to fix");
    expect(edited.marker).toBe("problem");
    expect(edited.label).not.toContain("checked");
    expect(edited.details.join(" ")).not.toContain("Every stop was checked");
    const restored = sourceText(fixturePlan(), "offline", { errors: 1, cause: "offline" });
    expect(restored.label).toBe("1 problem to fix");
    expect(restored.offline).toBe(false);
  });

  it("says a clean edited plan was edited and is still checked", () => {
    expect(sourceText(aiPlan(), "api", { edited: true }).label).toBe(
      "Planned with AI, edited by you, still checked against hours and distance",
    );
    expect(sourceText(fixturePlan(), "offline", { edited: true, cause: "offline" }).label).toBe(
      "Planned without AI, offline, edited by you",
    );
  });

  it("explains every fallback reason in plain words without jargon", () => {
    for (const reason of FALLBACK_REASONS) {
      const text = FALLBACK_TEXT[reason];
      expect(text.length).toBeGreaterThan(20);
      expect(text).not.toMatch(/schema|token|429|529|SDK/);
      expect(text.includes(EM_DASH)).toBe(false);
      const plan = fixturePlan();
      const details = sourceText(
        { ...plan, meta: { ...plan.meta, fallbackReason: reason } },
        "api",
      ).details;
      expect(details[0]).toBe(text);
    }
    expect(FALLBACK_TEXT.timeout).toBe(
      "The AI planner didn't return a valid plan in time, so this plan was built by rules. It follows the same checks.",
    );
  });
});

describe("base64url", () => {
  it("round-trips any Unicode text without padding or URL-unsafe characters", () => {
    for (const text of ["", "Caffè", "日本", "emoji \u{1F600}", "a+b/c="]) {
      const encoded = toBase64Url(text);
      expect(encoded).toMatch(/^[A-Za-z0-9_-]*$/);
      if (text !== "") expect(fromBase64Url(encoded)).toBe(text);
    }
    expect(fromBase64Url("")).toBeNull();
  });
});
