// @vitest-environment node
import type { Place } from "@italy/planner";
import { describe, expect, it } from "vitest";
import {
  baseRows,
  creditRows,
  hoursCounts,
  namesText,
  openAccessHours,
  plannerModel,
  typeRows,
  writtenWhen,
} from "../lib/aboutData";
import type { Health } from "../lib/apiSchemas";
import { type PhotoCreditRow, photoCredits } from "../lib/placePhotos";
import { ctx, must, places } from "./fixtures";

// The numbers "About this data" shows are computed from the loaded data, never typed in: these
// check they add up to the data and say what the data says.

describe("baseRows", () => {
  it("splits each base into its own city and its day trips, adding up to every place", () => {
    const rows = baseRows(ctx);
    expect(rows.map((row) => row.base)).toEqual(["Rome", "Florence", "Milan", "Venice", "Bologna"]);
    expect(rows.reduce((sum, row) => sum + row.total, 0)).toBe(places.length);
    for (const row of rows) {
      const trips = row.dayTrips.reduce((sum, trip) => sum + trip.count, 0);
      expect(row.inCity + trips, row.base).toBe(row.total);
    }
    const bologna = must(rows.find((row) => row.base === "Bologna"));
    expect(bologna.inCity).toBe(9);
    // Most places first, then by name.
    expect(bologna.dayTrips).toEqual([
      { city: "Modena", count: 3 },
      { city: "Parma", count: 2 },
      { city: "Isola della Scala", count: 1 },
      { city: "Maranello", count: 1 },
    ]);
  });

  it("skips an id the context does not hold", () => {
    const [rome] = ctx.anchors;
    const odd = {
      ...ctx,
      anchors: [{ ...must(rome), placeIds: ["nowhere", ...must(rome).placeIds] }],
    };
    expect(baseRows(odd)[0]).toMatchObject({ inCity: 30, total: 31 });
  });
});

describe("typeRows and hoursCounts", () => {
  it("count the places by type, most first, and by where their hours come from", () => {
    const types = typeRows(places);
    expect(types.reduce((sum, row) => sum + row.count, 0)).toBe(places.length);
    expect(types.slice(0, 3)).toEqual([
      { label: "Historic site", count: 19 },
      { label: "Restaurant", count: 19 },
      { label: "Experience", count: 17 },
    ]);
    expect(hoursCounts(places)).toEqual({ listed: 65, estimated: 10, openAccess: 17, unknown: 11 });
  });

  it("gives the planner's window for public spaces with no listed hours", () => {
    expect(openAccessHours()).toBe("07:00 to 23:00");
  });
});

describe("creditRows", () => {
  it("names every photo: a place's by the place, a city's as a city photo, places first", () => {
    const rows = creditRows(places);
    expect(rows).toHaveLength(photoCredits().length);
    const firstCity = rows.findIndex((row) => row.kind === "city");
    expect(rows.slice(firstCity).every((row) => row.kind === "city")).toBe(true);
    expect(rows.find((row) => row.key === "place_001")?.name).toBe("Colosseum");
    expect(rows.find((row) => row.key === "city:Rome")?.name).toBe("Rome, city photo");
    const names = rows.slice(0, firstCity).map((row) => row.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it("names a general photo by its type, and a place missing from the data by its id", () => {
    const credit = (key: string, kind: PhotoCreditRow["kind"], subject: string) => ({
      key,
      kind,
      subject,
      author: "A. Rossi",
      license: "CC BY 4.0",
      licenseUrl: null,
      sourceUrl: "https://commons.wikimedia.org/wiki/File:X.jpg",
      title: "X",
    });
    const rows = creditRows(places.slice(0, 1) as Place[], [
      credit("type:restaurant", "topic", "restaurant"),
      credit("place_999", "place", "place_999"),
    ]);
    expect(rows.map((row) => row.name)).toEqual(["place_999", "Restaurant, general photo"]);
  });
});

describe("photoCredits", () => {
  it("reads the kind and subject from each key", () => {
    const row = {
      file: "File:X.jpg",
      sourceUrl: "https://commons.wikimedia.org/wiki/File:X.jpg",
      author: "A. Rossi",
      license: "CC0",
      licenseUrl: null,
      width: 960,
      height: 640,
      description: "X",
      focal: "50% 50%",
    };
    const credits = photoCredits([
      { ...row, key: "place_001" },
      { ...row, key: "city:Isola della Scala" },
      { ...row, key: "type:market" },
    ]);
    expect(credits.map(({ kind, subject }) => [kind, subject])).toEqual([
      ["place", "place_001"],
      ["city", "Isola della Scala"],
      ["topic", "market"],
    ]);
  });

  it("titles each photo by its Commons file name, without the namespace or the extension", () => {
    const [credit] = photoCredits([
      {
        key: "place_001",
        file: "File:Bologna, Strada Maggiore, Piazetta dei Servi.JPG",
        sourceUrl: "https://commons.wikimedia.org/wiki/File:X.jpg",
        author: "A. Rossi",
        license: "CC BY-SA 3.0",
        licenseUrl: null,
        width: 960,
        height: 640,
        description: "X",
        focal: "50% 50%",
      },
    ]);
    expect(credit?.title).toBe("Bologna, Strada Maggiore, Piazetta dei Servi");
    for (const row of photoCredits()) expect(row.title, row.key).toMatch(/^\S.*\S$/);
  });
});

describe("namesText", () => {
  it("shortens long place lists", () => {
    const many = Array.from({ length: 11 }, (_, index) => ({ name: `P${index}` }));
    expect(namesText(many)).toBe("P0, P1, P2, P3, P4, P5, P6, P7 and 3 more");
    expect(namesText([{ name: "A" }, { name: "B" }])).toBe("A and B");
    expect(namesText([{ name: "A" }])).toBe("A");
  });
});

describe("writtenWhen", () => {
  it("gives the one day summaries were written, or the first and the last", () => {
    expect(writtenWhen({ firstDay: "2026-09-25", lastDay: "2026-09-25" })).toBe(
      "on 25 September 2026",
    );
    expect(writtenWhen({ firstDay: "2026-09-25", lastDay: "2026-10-02" })).toBe(
      "between 25 September 2026 and 2 October 2026",
    );
    expect(writtenWhen({ firstDay: null, lastDay: null })).toBe("");
  });
});

describe("plannerModel", () => {
  const health: Health = { ok: true, version: "1", commit: "x" };
  it("names a Claude model only when AI planning is available", () => {
    expect(plannerModel({ ...health, llmAvailable: true, model: "claude-sonnet-5" })).toBe(
      "claude-sonnet-5",
    );
    expect(plannerModel({ ...health, llmAvailable: true, model: "fixture" })).toBeNull();
    expect(plannerModel({ ...health, llmAvailable: false, model: "claude-sonnet-5" })).toBeNull();
    expect(plannerModel({ ...health, llmAvailable: true, model: null })).toBeNull();
    expect(plannerModel({ ...health })).toBeNull();
    expect(plannerModel(null)).toBeNull();
  });
});
