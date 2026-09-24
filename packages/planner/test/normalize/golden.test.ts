import { describe, expect, it } from "vitest";
import { placeNotes } from "../../src/normalize/chips";
import { formatClock, WEEKDAY_SHORT, type WEEKDAYS } from "../../src/time";
import type { DateRule, Place, WeeklyHours } from "../../src/types";
import { realResult } from "../helpers";

// Record-by-record check of all 103 places (task T10). Each entry is what the planner will
// believe about one place: hours per weekday (closes after midnight marked +1), how estimated
// hours were derived, date rules, visit length, price, meals, coordinates and their source,
// neighborhood, linked places, tags, booking, and the chips the traveler sees. The golden file was reviewed line by line against the
// raw data. Any normalizer change that moves a real place shows up here as a readable diff, and
// CI refuses to write a new golden file on its own.

/** "08:00-01:00+1" for a range that closes after midnight, so 1500 never reads as 60. */
function clockText(minutes: number): string {
  return `${formatClock(minutes)}${minutes > 1440 ? "+1" : ""}`;
}

function rangesText(hours: WeeklyHours, day: (typeof WEEKDAYS)[number]): string {
  const ranges = hours[day].map((range) => `${clockText(range.open)}-${clockText(range.close)}`);
  return ranges.length > 0 ? ranges.join("+") : "closed";
}

/** "Mon-Sat 09:00-18:00, Sun closed", grouping consecutive days with the same hours. */
function weekText(hours: WeeklyHours | null): string {
  if (hours === null) return "unknown";
  const order = [1, 2, 3, 4, 5, 6, 0] as const; // Monday first, as the data writes it
  const groups: { from: number; to: number; text: string }[] = [];
  for (const day of order) {
    const text = rangesText(hours, day);
    const last = groups[groups.length - 1];
    if (last && last.text === text) last.to = day;
    else groups.push({ from: day, to: day, text });
  }
  return groups
    .map(
      (g) =>
        `${WEEKDAY_SHORT[g.from]}${g.from === g.to ? "" : `-${WEEKDAY_SHORT[g.to]}`} ${g.text}`,
    )
    .join(", ");
}

function ruleText(rule: DateRule): string {
  if (rule.kind === "season")
    return `season ${rule.window.from.month}/${rule.window.from.day}-${rule.window.to.month}/${rule.window.to.day}`;
  if (rule.kind === "weekdays")
    return `only ${rule.days.map((day) => WEEKDAY_SHORT[day]).join("/")}`;
  return `only days ${rule.from}-${rule.to} of the month`;
}

function derivationText(place: Place): string {
  const derived = place.hoursDerivation;
  if (!derived) return "";
  return ` (${derived.source} "${derived.match}" ${clockText(derived.window.open)}-${clockText(derived.window.close)})`;
}

const yesNo = (value: boolean | null) => (value === null ? "?" : value ? "yes" : "no");

function goldenLine(place: Place): string {
  const rules = place.dateRules.length > 0 ? `; ${place.dateRules.map(ruleText).join("; ")}` : "";
  const point = `(${place.lat.toFixed(5)}, ${place.lng.toFixed(5)})`;
  const parts = [
    `${place.id} [${place.type}] ${place.name}`,
    `  hours ${place.hoursConfidence}${derivationText(place)}: ${weekText(place.hours)}${rules}`,
    `  visit ${place.durationMin} ${place.durationSource}; price ${place.priceLevel ?? "?"}; rating ${place.rating ?? "?"}; meals ${place.meals.join("+") || "none"}`,
    `  where ${place.city}, ${place.neighborhood ?? "-"} ${point} ${place.locationSource}; linked ${place.sharedLocationWith.join(", ") || "none"}`,
    `  tags ${place.tags.join(", ") || "none"}; booking ${yesNo(place.bookingRequired)}; book ahead ${yesNo(place.bookAhead)}`,
    `  chips: ${
      placeNotes(place)
        .map((note) => note.label)
        .join("; ") || "none"
    }`,
  ];
  return parts.join("\n");
}

describe("golden record-by-record view of the real data", () => {
  it("matches the reviewed golden file, so no real place changes silently", async () => {
    const text = `${realResult().places.map(goldenLine).join("\n")}\n`;
    await expect(text).toMatchFileSnapshot("./__golden__/places.txt");
  });
});
