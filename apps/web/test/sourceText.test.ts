import { FALLBACK_REASONS, type FallbackReason } from "@italy/planner";
import { describe, expect, it } from "vitest";
import { fromBase64Url, toBase64Url } from "../lib/base64url";
import { FALLBACK_CLAIM, ON_DEVICE_CLAIM, sourceText } from "../lib/sourceText";
import { aiPlan, fixturePlan } from "./fixtures";

const EM_DASH = String.fromCharCode(0x2014);

// The source line is the product's honesty: it must never claim AI for a rules plan, and every
// fallback reason needs a few plain words.

const NOW = new Date(2026, 8, 25, 12);

/** A rules plan the API made for `reason`. */
function fallback(reason: FallbackReason) {
  const plan = fixturePlan();
  return { ...plan, meta: { ...plan.meta, fallbackReason: reason } };
}

describe("sourceText", () => {
  it("says who planned it for every source, in one short claim", () => {
    const ai = aiPlan();
    expect(sourceText(ai, "api")).toEqual({
      claim: "Planned with AI",
      problem: null,
      offline: false,
      marker: "ai",
    });
    expect(sourceText({ ...ai, source: "ai_repaired" }, "api")).toMatchObject({
      claim: "Planned with AI, fixed after a check",
      marker: "ai",
    });
    expect(sourceText(fixturePlan(), "api")).toMatchObject({
      claim: "Planned without AI",
      marker: "rules",
    });
    expect(sourceText(ai, "shared")).toMatchObject({
      claim: "Shared plan, rebuilt from its places",
      marker: "rules",
    });
  });

  it.each([
    ["requested", "Planned without AI"],
    ["no_key", "Planned without AI: the AI planner is off"],
    ["disabled", "Planned without AI: the AI planner is off"],
    ["timeout", "Planned without AI: the AI planner timed out"],
    ["rate_limited", "Planned without AI: the AI planner was busy"],
    ["refusal", "Planned without AI: the AI planner declined"],
    ["invalid_after_repair", "Planned without AI: the AI's plan broke a rule"],
    ["schema_invalid", "Planned without AI: the AI planner failed"],
    ["max_tokens", "Planned without AI: the AI planner failed"],
    ["llm_error", "Planned without AI: the AI planner failed"],
  ] as const)("says in a few words why a rules plan was made (%s)", (reason, claim) => {
    expect(sourceText(fallback(reason), "api")).toMatchObject({ claim, marker: "rules" });
  });

  it("words every fallback reason plainly and briefly", () => {
    for (const reason of FALLBACK_REASONS) {
      const claim = FALLBACK_CLAIM[reason];
      expect(claim.startsWith("Planned without AI")).toBe(true);
      expect(claim.length).toBeLessThanOrEqual(46);
      expect(claim).not.toMatch(/schema|token|429|529|SDK/);
      expect(claim.includes(EM_DASH)).toBe(false);
    }
  });

  it("labels a browser-built plan offline only when the server could not be reached", () => {
    const plan = fixturePlan();
    expect(sourceText(plan, "offline", { cause: "offline" })).toMatchObject({
      claim: "Planned on this device, offline",
      offline: true,
      marker: "rules",
    });
    // Restored from storage without a cause: honest about where, silent about why.
    expect(sourceText(plan, "offline")).toMatchObject({
      claim: "Planned on this device",
      offline: false,
    });
  });

  it.each([
    ["timeout", "Planned on this device: the server timed out"],
    ["busy", "Planned on this device: the server was busy"],
    ["server", "Planned on this device: the server failed"],
    ["unreadable", "Planned on this device: the reply was unreadable"],
    ["invalid", "Planned on this device: the server's plan broke a rule"],
  ] as const)("never says offline when the service answered (%s)", (cause, claim) => {
    const text = sourceText(fixturePlan(), "offline", { cause });
    expect(text.claim).toBe(claim);
    expect(ON_DEVICE_CLAIM[cause]).toBe(claim);
    expect(text.offline).toBe(false);
    expect(text.claim).not.toContain("offline");
  });

  it("keeps the claim and gives the count to fix when the current plan breaks a rule", () => {
    const edited = sourceText(aiPlan(), "api", { errors: 2, edited: true });
    expect(edited).toEqual({
      claim: "Planned with AI, edited",
      problem: "2 problems to fix",
      offline: false,
      marker: "problem",
    });
    const restored = sourceText(fixturePlan(), "offline", { errors: 1, cause: "offline" });
    expect(restored).toMatchObject({
      claim: "Planned on this device, offline",
      problem: "1 problem to fix",
      offline: true,
      marker: "problem",
    });
  });

  it("says a clean plan the traveler changed was edited, and keeps its mark", () => {
    expect(sourceText(aiPlan(), "api", { edited: true })).toMatchObject({
      claim: "Planned with AI, edited",
      marker: "ai",
    });
    expect(sourceText(fixturePlan(), "offline", { edited: true, cause: "offline" }).claim).toBe(
      "Planned on this device, offline, edited",
    );
    expect(sourceText(fallback("timeout"), "api", { edited: true }).claim).toBe(
      "Planned without AI: the AI planner timed out, edited",
    );
  });

  describe("a trip opened from a saved link", () => {
    const saved = {
      id: "a1B2c3D4e5",
      createdAt: new Date(2026, 8, 20, 12).toISOString(),
      plannedBy: "ai" as const,
      edited: false,
      retimed: false,
    };

    it("says it is a saved trip, how it was planned and the day it was saved, with the AI's mark", () => {
      expect(sourceText(aiPlan(), "saved", { saved, now: NOW })).toEqual({
        claim: "Saved trip, planned with AI, saved 20 Sep",
        problem: null,
        offline: false,
        marker: "ai",
      });
      const fixed = { ...saved, plannedBy: "ai_repaired" as const };
      expect(sourceText(aiPlan(), "saved", { saved: fixed, now: NOW }).claim).toBe(
        "Saved trip, planned with AI, saved 20 Sep",
      );
    });

    it("names the year of a trip saved in another year", () => {
      const old = { ...saved, createdAt: new Date(2025, 11, 30, 12).toISOString() };
      expect(sourceText(aiPlan(), "saved", { saved: old, now: NOW }).claim).toBe(
        "Saved trip, planned with AI, saved 30 Dec 2025",
      );
    });

    it("says edited when it was edited before it was saved, or since", () => {
      const before = { ...saved, edited: true };
      expect(sourceText(aiPlan(), "saved", { saved: before, now: NOW }).claim).toBe(
        "Saved trip, planned with AI, saved 20 Sep, edited",
      );
      expect(sourceText(aiPlan(), "saved", { saved, edited: true, now: NOW }).claim).toBe(
        "Saved trip, planned with AI, saved 20 Sep, edited",
      );
    });

    it("claims neither the AI nor the rules without an AI plan on record", () => {
      const text = sourceText(fixturePlan(), "saved", {
        saved: { ...saved, plannedBy: "rules" },
        now: NOW,
      });
      expect(text).toMatchObject({ claim: "Saved trip, saved 20 Sep", marker: "rules" });
      expect(text.claim).not.toContain("AI");
    });

    it("gives a trip timed again with newer place data the rules' mark", () => {
      const text = sourceText(fixturePlan(), "saved", {
        saved: { ...saved, retimed: true },
        now: NOW,
      });
      expect(text).toMatchObject({
        claim: "Saved trip, planned with AI, saved 20 Sep",
        marker: "rules",
      });
    });

    it("stays honest without the saved details, or with an unreadable date", () => {
      expect(sourceText(aiPlan(), "saved")).toMatchObject({
        claim: "Saved trip",
        marker: "rules",
      });
      expect(
        sourceText(aiPlan(), "saved", { saved: { ...saved, createdAt: "garbage" }, now: NOW })
          .claim,
      ).toBe("Saved trip, planned with AI");
    });
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
