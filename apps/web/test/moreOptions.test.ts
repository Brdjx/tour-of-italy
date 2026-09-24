import { describe, expect, it } from "vitest";
import {
  clearOptions,
  moreOptionsName,
  optionCount,
  requestOptionCount,
  setBadgeText,
  setOptionGroups,
  visibleInterests,
} from "../lib/moreOptions";
import { defaultFormValues, type TripFormValues } from "../lib/tripForm";
import { tripDateRange, tripSummaryText } from "../lib/tripSummary";
import { makeRequest } from "./fixtures";

// The counts and the summary line are what a traveler reads instead of the folded form. A wrong
// count hides a filter that is still shaping the plan; a wrong date range describes a different
// trip from the timetable below it.

const base = defaultFormValues(new Date(2026, 8, 23));
const values = (overrides: Partial<TripFormValues>): TripFormValues => ({ ...base, ...overrides });

describe("option count", () => {
  it("counts nothing for the defaults, so a fresh form shows no badge", () => {
    expect(optionCount(base)).toBe(0);
    expect(setBadgeText(0)).toBeNull();
    expect(moreOptionsName(0)).toBe("More options");
  });

  it("counts each group once, however many chips or places it has", () => {
    const set = values({
      interests: ["food", "art", "wine"],
      maxPriceLevel: 2,
      mustInclude: ["place_001", "place_002"],
      exclude: ["place_003"],
      notes: "Slow mornings",
    });
    expect(setOptionGroups(set)).toEqual([
      "interests",
      "budget",
      "mustInclude",
      "exclude",
      "notes",
    ]);
    expect(moreOptionsName(optionCount(set))).toBe("More options, 5 set");
  });

  it("counts choosing bases even before a base is picked, where the form's error points", () => {
    expect(setOptionGroups(values({ anchorMode: "choose" }))).toEqual(["bases"]);
  });

  it("never counts notes that are only spaces, which the request drops", () => {
    expect(optionCount(values({ notes: "   \n " }))).toBe(0);
  });

  it("never counts the date or the pace, which are always on screen", () => {
    expect(optionCount(values({ startDate: "2027-01-01", pace: "packed" }))).toBe(0);
  });

  it("counts a sent request the same way as the form that made it", () => {
    const request = makeRequest({ interests: ["food"], anchors: ["rome"], maxPriceLevel: null });
    expect(requestOptionCount(request)).toBe(2);
  });
});

describe("clear options", () => {
  it("resets every option and keeps the date and pace", () => {
    const set = values({
      startDate: "2026-11-02",
      pace: "relaxed",
      interests: ["food"],
      maxPriceLevel: 1,
      anchorMode: "choose",
      anchors: ["rome"],
      mustInclude: ["place_001"],
      exclude: ["place_002"],
      notes: "x",
    });
    expect(clearOptions(set)).toEqual({ ...base, startDate: "2026-11-02", pace: "relaxed" });
  });
});

describe("visible interests", () => {
  const interests = [
    { tag: "quiet", label: "Quiet", count: 9 },
    { tag: "food", label: "Food", count: 39 },
    { tag: "art", label: "Art", count: 18 },
    { tag: "wine", label: "Wine", count: 12 },
    { tag: "views", label: "Views", count: 22 },
  ];

  it("shows the most common first, even when the source order is different", () => {
    const shown = visibleInterests(interests, [], false, 3);
    expect(shown.map((item) => item.tag)).toEqual(["food", "views", "art"]);
  });

  it("keeps a picked interest in view when it is not among the most common", () => {
    const shown = visibleInterests(interests, ["quiet"], false, 3);
    expect(shown.map((item) => item.tag)).toEqual(["food", "views", "art", "quiet"]);
  });

  it("shows every interest when asked", () => {
    expect(visibleInterests(interests, [], true, 3)).toHaveLength(interests.length);
  });

  it("keeps the incoming order for interests with the same count", () => {
    const tied = [
      { tag: "b", label: "B", count: 5 },
      { tag: "a", label: "A", count: 5 },
    ];
    expect(visibleInterests(tied, [], false, 1).map((item) => item.tag)).toEqual(["b"]);
  });
});

describe("trip summary line", () => {
  it("names the first and last day, the pace, and no options for a plain request", () => {
    expect(tripSummaryText(makeRequest({ interests: [] }))).toBe(
      "Tue 6 Oct to Thu 8 Oct, balanced pace",
    );
  });

  it("adds the number of options set, in words that match the count", () => {
    expect(tripSummaryText(makeRequest({ interests: ["food"] }))).toBe(
      "Tue 6 Oct to Thu 8 Oct, balanced pace, 1 option",
    );
    const busy = makeRequest({
      pace: "packed",
      interests: ["food"],
      maxPriceLevel: 3,
      notes: "Late dinners",
    });
    expect(tripSummaryText(busy)).toBe("Tue 6 Oct to Thu 8 Oct, packed pace, 3 options");
  });

  it("crosses a month and a year end on the right days", () => {
    expect(tripDateRange("2026-10-30")).toBe("Fri 30 Oct to Sun 1 Nov");
    expect(tripDateRange("2026-12-31")).toBe("Thu 31 Dec to Sat 2 Jan");
    expect(tripDateRange("2028-02-28")).toBe("Mon 28 Feb to Wed 1 Mar");
  });

  it("never throws on a date it cannot read; it shows the text as given", () => {
    expect(tripDateRange("2026-02-30")).toBe("2026-02-30");
    expect(tripDateRange("")).toBe("");
    expect(tripDateRange("2026-10-06", 0)).toBe("2026-10-06");
    expect(tripDateRange("2026-10-06", 1)).toBe("Tue 6 Oct");
  });
});
