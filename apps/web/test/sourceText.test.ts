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

  describe("a trip opened from a saved link", () => {
    const saved = {
      id: "a1B2c3D4e5",
      createdAt: "2026-09-20T12:00:00.000Z",
      plannedBy: "ai" as const,
      edited: false,
      retimed: false,
    };

    it("says how it was planned and that it is a saved trip, with the AI's mark", () => {
      const text = sourceText(aiPlan(), "saved", { saved });
      expect(text.label).toBe("Planned with AI, saved trip, checked against hours and distance");
      expect(text.marker).toBe("ai");
      expect(text.details[0]).toBe(
        "Saved on 20 September 2026. The times and why lines are as they were saved.",
      );
      expect(text.details).toContain("The AI planner chose the places from the data.");
      expect(text.details.at(-1)).toContain("A filled dot marks a reason written by the AI");
    });

    it("says a fixed draft was fixed and an edited trip was edited before saving", () => {
      const text = sourceText(aiPlan(), "saved", {
        saved: { ...saved, plannedBy: "ai_repaired", edited: true },
      });
      expect(text.details[1]).toContain("first draft broke a rule and was fixed");
      expect(text.details).toContain("It was edited before it was saved.");
    });

    it("claims neither the AI nor the rules without an AI plan on record", () => {
      const text = sourceText(fixturePlan(), "saved", { saved: { ...saved, plannedBy: "rules" } });
      expect(text.label).toBe("Saved trip, checked against hours and distance");
      expect(text.marker).toBe("rules");
      expect(text.details[1]).toBe("Its why lines come from the rules.");
      expect(text.label).not.toContain("without AI");
    });

    it("says a trip timed again with newer place data has the rules' why lines", () => {
      const ai = sourceText(fixturePlan(), "saved", { saved: { ...saved, retimed: true } });
      expect(ai.label).toBe("Planned with AI, saved trip, checked against hours and distance");
      expect(ai.marker).toBe("rules");
      expect(ai.details[0]).toContain("its times were worked out again");
      expect(ai.details.join(" ")).not.toContain("filled dot");
      const rules = sourceText(fixturePlan(), "saved", {
        saved: { ...saved, plannedBy: "rules", retimed: true },
      });
      expect(rules.details.filter((line) => line.includes("why lines come from"))).toHaveLength(1);
    });

    it("stays honest without the saved details, or with an unreadable date, and after edits", () => {
      expect(sourceText(aiPlan(), "saved").label).toBe(
        "Saved trip, checked against hours and distance",
      );
      expect(
        sourceText(aiPlan(), "saved", { saved: { ...saved, createdAt: "garbage" } }).details[0],
      ).toBe("Saved. The times and why lines are as they were saved.");
      expect(sourceText(aiPlan(), "saved", { saved, edited: true }).label).toBe(
        "Planned with AI, saved trip, edited by you, still checked against hours and distance",
      );
    });

    it("stops saying the times are as saved once the traveler edits the trip", () => {
      const details = sourceText(aiPlan(), "saved", { saved, edited: true }).details;
      expect(details[0]).toBe("Saved on 20 September 2026.");
      expect(details.join(" ")).not.toContain("as they were saved");
      expect(details.at(-1)).toBe("You changed this plan, and every change was checked again.");
    });
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
