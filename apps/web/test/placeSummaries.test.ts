// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  MODEL,
  mergeRun,
  PROMPT_VERSION,
  parseAnswer,
} from "../../../scripts/generate-place-summaries";
import { summaryForPlace, summaryRecord } from "../lib/placeSummaries";
import file from "../lib/placeSummaries.data.json";
import {
  checkSummary,
  MAX_SUMMARY_CHARS,
  type SummaryProblemKind,
  summaryInput,
  summarySource,
} from "../lib/placeSummaryCheck";
import { place, places } from "./fixtures";

// The AI summaries say nothing a place's own listing does not: the code check refuses numbers,
// times, dates, prices, booking, meals, names and superlatives the listing lacks, and anything
// outside the house voice. The saved file is checked again here, so a hand edit that breaks a
// rule fails CI the same way a model answer would have failed the script, and a run whose calls
// failed cannot quietly empty it.

const colosseum = summarySource(place("place_001"));
const leftOutRows = file.leftOut as { placeId: string; reasons: string[] }[];
const kinds = (text: string) => checkSummary(text, colosseum).map((problem) => problem.kind);

describe("summarySource", () => {
  it("takes only the place's own listing, and sends the model everything but the region", () => {
    expect(colosseum).toMatchObject({
      name: "Colosseum",
      type: "Historic site",
      city: "Rome",
      region: "Lazio",
      neighbourhood: "Celio",
      typicalVisitMinutes: 120,
      rating: 4.8,
      hours: "9:00-19:00",
    });
    expect(summaryInput(colosseum)).not.toHaveProperty("region");
    expect(summaryInput(colosseum).name).toBe("Colosseum");
  });

  it("has no hours text when the listing has none", () => {
    expect(summarySource(place("place_018")).hours).toBeNull();
  });
});

describe("checkSummary", () => {
  it("accepts a summary made of the listing's own words", () => {
    const good =
      "The Colosseum is an iconic historic site in Rome's Celio area. Its underground and arena floor draw crowds, and it is quieter early in the morning.";
    expect(checkSummary(good, colosseum)).toEqual([]);
  });

  it("accepts numbers, names and superlatives the listing has, and Italy and the region", () => {
    expect(kinds("The Colosseum is the most iconic structure in Rome.")).toEqual([]);
    expect(kinds("It is one of the sights of Italy, in Lazio.")).toContain("number");
    expect(kinds("It is a sight in Italy and Lazio.")).toEqual([]);
    expect(kinds("Colosseum crowds fill the arena floor.")).toEqual([]);
    expect(kinds("The Colosseum is open from 9:00 to 19:00.")).toEqual([]);
  });

  it("takes numbers only from the listing's words, not its rating, price level or visit length", () => {
    // Colosseum: rating 4.8, price level 2, a 120 minute visit.
    expect(kinds("The Colosseum is rated 4.8.")).toContain("number");
    expect(kinds("The Colosseum has 2 underground levels.")).toContain("number");
    expect(kinds("The Colosseum has 120 arches.")).toContain("number");
  });

  it("reads a word's forms as one word, so the listing's Book allows booked", () => {
    const osteria = summarySource(place("place_043"));
    expect(checkSummary("Osteria Francescana is booked months in advance.", osteria)).toEqual([]);
    expect(kinds("The Colosseum is booked solid.")).toEqual([]);
    expect(kinds("The Colosseum is priced high.")).toContain("price");
    expect(kinds("The Colosseum is reserved for tours.")).toContain("booking");
    // "evening" is its own word, not "even" with an ending.
    expect(kinds("The Colosseum is even busier.")).toEqual([]);
  });

  it("refuses a sentence that opens with the listing's instructions", () => {
    expect(kinds("Go early morning or book the evening experience.")).toContain("sentence_start");
    expect(kinds("Avoid the worst of the crowds at the Colosseum.")).toContain("sentence_start");
    expect(kinds("Rome's Colosseum draws crowds.")).toEqual([]);
    expect(kinds("Celio holds the Colosseum.")).toEqual([]);
    expect(kinds("Historic crowds fill the Colosseum.")).toEqual([]);
  });

  const cases: [SummaryProblemKind, string][] = [
    ["empty", "   "],
    ["length", `The Colosseum ${"is iconic and ".repeat(20)}crowded.`],
    ["sentences", "The Colosseum is iconic. It is historic. It is crowded."],
    ["second_person", "The Colosseum rewards your patience."],
    ["second_person", "The Colosseum is where you’ll queue."],
    ["first_person", "The Colosseum is where we start."],
    ["dash", "The Colosseum is iconic — and crowded."],
    ["dash", "The Colosseum is iconic - and crowded."],
    ["exclamation", "The Colosseum is iconic!"],
    ["emoji", "The Colosseum is iconic 🏛️."],
    ["number", "The Colosseum holds 50,000 people."],
    ["number", "The Colosseum takes three hours."],
    ["time", "The Colosseum glows at sunset."],
    ["time", "The Colosseum opens at noon."],
    ["date", "The Colosseum is busiest on Sundays."],
    ["date", "The Colosseum is quiet in winter."],
    ["price", "The Colosseum is expensive."],
    ["price", "The Colosseum costs €18."],
    ["booking", "The Colosseum needs a reservation."],
    ["booking", "The Colosseum sells out and needs tickets in advance."],
    ["booking", "The Colosseum can sell out."],
    ["booking", "The Colosseum has a waitlist."],
    ["time", "The Colosseum is open tonight and today."],
    ["time", "The Colosseum is quieter tomorrow."],
    ["number", "The Colosseum has several levels and a couple of tunnels."],
    ["number", "The Colosseum sees a billion visitors and zero quiet."],
    ["number", "The Colosseum is a double arena."],
    ["superlative", "The Colosseum is the top sight in Rome and world famous."],
    ["superlative", "The Colosseum is world-class."],
    ["superlative", "The Colosseum is a top-rated ruin."],
    ["superlative", "The Colosseum is unrivalled."],
    ["meal", "The Colosseum is near good places for lunch."],
    ["superlative", "The Colosseum is the grandest ruin in Rome."],
    ["superlative", "The Colosseum is the best sight in Rome."],
    ["proper_noun", "The Colosseum was finished under Titus."],
    ["sentence_start", "Vespasian began the Colosseum."],
  ];
  it.each(cases)("rejects %s: %s", (kind, text) => {
    expect(kinds(text)).toContain(kind);
  });

  it("says what is wrong in words the retry can send back", () => {
    const [problem] = checkSummary("The Colosseum was finished under Titus.", colosseum);
    expect(problem?.detail).toBe('It names "Titus", which the listing does not.');
  });

  it("does not split a sentence after St.", () => {
    const basilica = summarySource(place("place_074"));
    const text =
      "St. Mark's Basilica is a Byzantine cathedral covered in gold mosaics. It draws many tourists.";
    expect(checkSummary(text, basilica)).toEqual([]);
  });

  it("does not read words like interest or west as superlatives", () => {
    expect(kinds("The Colosseum holds interest for crowds.")).toEqual([]);
  });

  it("does not read selling as booking unless it is selling out", () => {
    expect(kinds("The Colosseum has stands that sell water.")).toEqual([]);
  });
});

describe("the saved summaries", () => {
  it("each record the model, the prompt version and the day that wrote it", () => {
    const versions = new Set(["place-summary-v1", PROMPT_VERSION]);
    for (const row of [...file.summaries, ...leftOutRows]) {
      const written = row as unknown as { model: string; promptVersion: string; writtenOn: string };
      expect(written.model, row.placeId).toBe(MODEL);
      expect(versions.has(written.promptVersion), row.placeId).toBe(true);
      expect(written.writtenOn, row.placeId).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    for (const row of file.summaries)
      expect([...row.text].length).toBeLessThanOrEqual(MAX_SUMMARY_CHARS);
  });

  it("were not emptied by a run whose calls failed", () => {
    // A failed call keeps the place's old row (mergeRun); it is never saved as left out.
    for (const row of leftOutRows) {
      for (const reason of row.reasons) expect(reason, row.placeId).not.toMatch(/^The call failed/);
    }
    expect(file.summaries.length).toBeGreaterThanOrEqual(95);
  });

  it("each pass the code check against their own place's listing", () => {
    for (const row of file.summaries) {
      const source = summarySource(place(row.placeId));
      expect(checkSummary(row.text, source), `${row.placeId}: ${row.text}`).toEqual([]);
    }
  });

  it("cover every place once, as a summary or as left out with its reasons", () => {
    const summarized = file.summaries.map((row) => row.placeId);
    const leftOut = leftOutRows.map((row) => row.placeId);
    expect(new Set([...summarized, ...leftOut]).size).toBe(summarized.length + leftOut.length);
    expect([...summarized, ...leftOut].sort()).toEqual(places.map((item) => item.id).sort());
    for (const row of leftOutRows) expect(row.reasons.length).toBeGreaterThan(0);
  });

  it("are found by place id, and a place without one has none", () => {
    const first = file.summaries[0];
    expect(summaryForPlace(first?.placeId ?? "")).toBe(first?.text);
    expect(summaryForPlace("no-such-place")).toBeNull();
  });

  it("say how many of a set of places have one, which models wrote them and on which days", () => {
    const record = summaryRecord(places.map((item) => item.id));
    expect(record.count).toBe(file.summaries.length);
    expect(record.models).toEqual([MODEL]);
    expect(record.firstDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect((record.lastDay ?? "") >= (record.firstDay ?? "~")).toBe(true);
    expect(summaryRecord(["no-such-place"])).toEqual({
      count: 0,
      models: [],
      firstDay: null,
      lastDay: null,
    });
  });
});

describe("mergeRun", () => {
  const written = { model: "claude-x", promptVersion: "v9", writtenOn: "2026-10-01" };
  const old = { model: "claude-old", promptVersion: "v1", writtenOn: "2026-09-25" };
  const previous = {
    summaries: [
      { placeId: "p1", text: "Old one.", attempts: 1 as const, ...old },
      { placeId: "p2", text: "Old two.", attempts: 1 as const, ...old },
    ],
    leftOut: [{ placeId: "p3", reasons: ["It has a dash."], ...old }],
  };

  it("labels only the rows this run wrote, and keeps the rest as they were", () => {
    const file = mergeRun(previous, [{ placeId: "p2", text: "New two.", attempts: 2 }], written);
    expect(file.summaries).toEqual([
      previous.summaries[0],
      { placeId: "p2", text: "New two.", attempts: 2, ...written },
    ]);
    expect(file.leftOut).toEqual(previous.leftOut);
  });

  it("keeps a place's old row when its call failed, and never saves the failure", () => {
    const file = mergeRun(
      previous,
      [
        { placeId: "p1", callFailed: "401 invalid x-api-key" },
        { placeId: "p3", callFailed: "Connection error." },
        { placeId: "p2", reasons: ["It has a dash.", "It has a dash."] },
      ],
      written,
    );
    expect(file.summaries).toEqual([previous.summaries[0]]);
    expect(file.leftOut).toEqual([
      { placeId: "p2", reasons: ["It has a dash.", "It has a dash."], ...written },
      previous.leftOut[0],
    ]);
  });

  it("starts a new file, sorted by place id, when there is none", () => {
    const file = mergeRun(
      null,
      [
        { placeId: "p9", text: "Nine.", attempts: 1 },
        { placeId: "p4", text: "Four.", attempts: 1 },
        { placeId: "p5", callFailed: "Overloaded" },
      ],
      written,
    );
    expect(file.summaries.map((row) => row.placeId)).toEqual(["p4", "p9"]);
    expect(file.leftOut).toEqual([]);
  });
});

describe("parseAnswer", () => {
  it("reads the summary from the model's JSON, and nothing else", () => {
    expect(parseAnswer('{"summary": " The Colosseum is iconic. "}')).toBe(
      "The Colosseum is iconic.",
    );
    expect(parseAnswer('{"summary": 3}')).toBeNull();
    expect(parseAnswer('{"text": "x"}')).toBeNull();
    expect(parseAnswer("null")).toBeNull();
    expect(parseAnswer("not json")).toBeNull();
  });
});
