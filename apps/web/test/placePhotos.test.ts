// @vitest-environment node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import raw from "../../../data/italy.json";
import curation from "../../../data/place-photos.json";
import {
  authorOf,
  fileStem,
  isAllowedLicense,
  jpegSize,
} from "../../../scripts/fetch-place-photos";
import { HIGHLIGHT_PLACE_IDS, photoForPlace, placeHasOwnPhoto } from "../lib/placePhotos";
import rows from "../lib/placePhotos.data.json";
import { places } from "./fixtures";

// Every place shows a real, credited photo, and a photo that is not of the place never pretends
// to be: its alt text and note say what it is not. The files the page asks for are committed.

const PUBLIC = fileURLToPath(new URL("../public", import.meta.url));

// The same rule as scripts/fetch-place-photos.ts, written out again so a hand edit of the
// generated data cannot slip in another license: CC0, public domain and the PD marks, and
// Creative Commons BY or BY-SA of any version.
const ALLOWED =
  /^(CC0( 1\.0)?|Public domain( mark( \d\.\d)?)?|PDM( \d\.\d)?|CC BY(-SA)? \d\.\d( [a-z]{2,3})?)$/i;

const rawPlaces = raw as { id: string; name: string; city: string; type: string }[];

function mustPhoto(place: { id: string; name: string; city: string; type: string }) {
  const photo = photoForPlace(place);
  if (!photo) throw new Error(`${place.id} has no photo`);
  return photo;
}

/** Every URL a photo can load: src and each srcSet candidate. */
function urlsOf(photo: { src: string; srcSet: string }): string[] {
  const candidates = photo.srcSet.split(",").map((part) => part.trim().split(" ")[0] ?? "");
  return [photo.src, ...candidates];
}

describe("photoForPlace", () => {
  it("finds a photo for every place in data/italy.json, raw and normalized", () => {
    expect(rawPlaces).toHaveLength(103);
    for (const place of [...rawPlaces, ...places]) {
      expect(photoForPlace(place), place.id).not.toBeNull();
    }
  });

  it("uses the place's own photo, with its description as the alt text and no note", () => {
    const colosseum = rawPlaces.find((place) => place.id === "place_001");
    const photo = mustPhoto(colosseum ?? { id: "", name: "", city: "", type: "" });
    expect(photo).toMatchObject({
      kind: "place",
      src: "/photos/place_001-960.jpg",
      srcSet: "/photos/place_001-500.jpg 500w, /photos/place_001-960.jpg 960w",
      alt: "The Colosseum's outer ring and its broken upper section",
      note: null,
    });
    expect(placeHasOwnPhoto("place_001")).toBe(true);
  });

  // Every city with a place that has no photo of its own has a city photo, so no general (topic)
  // photo is curated today; the library still reads one from the curation if it is ever added.
  it("falls back to the city photo, then to nothing", () => {
    const base = { id: "made-up", name: "Trattoria Nowhere" };
    const city = mustPhoto({ ...base, city: "Isola della Scala", type: "restaurant" });
    expect(city.kind).toBe("city");
    expect(city.src).toBe("/photos/city-isola-della-scala-960.jpg");
    expect(city.alt).toMatch(/ \(a photo of Isola della Scala, not Trattoria Nowhere\)$/);
    expect(city.note).toBe("City photo of Isola della Scala, not this place.");

    expect(photoForPlace({ ...base, city: "Atlantis", type: "restaurant" })).toBeNull();
    expect(placeHasOwnPhoto("made-up")).toBe(false);
  });

  it("never presents a city or topic photo as the place", () => {
    const standIns = rawPlaces.filter((place) => !placeHasOwnPhoto(place.id));
    expect(standIns.length).toBeGreaterThan(0);
    for (const place of standIns) {
      const photo = mustPhoto(place);
      expect(photo.kind).not.toBe("place");
      expect(photo.alt).toContain(`not ${place.name})`);
      expect(photo.note).toMatch(/, not this place\.$/);
    }
  });

  it("credits every photo as 'Photo: author, license' with a Commons source", () => {
    for (const place of rawPlaces) {
      const photo = mustPhoto(place);
      expect(photo.credit).toBe(`Photo: ${photo.author}, ${photo.license}`);
      expect(photo.author.trim()).not.toBe("");
      expect(photo.sourceUrl).toMatch(/^https:\/\/commons\.wikimedia\.org\/wiki\/File:/);
    }
  });
});

describe("the generated photo data", () => {
  it("has one row per curated photo, sorted by key", () => {
    const curated = [...Object.keys(curation.places), ...Object.keys(curation.fallbacks)].sort();
    expect(rows.map((row) => row.key)).toEqual(curated);
  });

  it("only uses licenses the site may show", () => {
    for (const row of rows) {
      expect(row.license, row.key).toMatch(ALLOWED);
      if (!row.license.startsWith("Public domain")) expect(row.licenseUrl, row.key).toBeTruthy();
    }
  });

  it("has a plain description and a CSS focal point for every photo", () => {
    for (const row of rows) {
      expect(row.description.trim(), row.key).not.toBe("");
      expect(row.description, row.key).not.toContain("—");
      expect(row.focal, row.key).toMatch(/^\d{1,3}% \d{1,3}%$/);
      expect(row.width, row.key).toBe(960);
      expect(row.height, row.key).toBeGreaterThan(0);
    }
  });

  it("has every file a photo can load committed under public/photos, as a JPEG", () => {
    const allRowsAsPlaces = rows.map((row) => {
      const [prefix, rest = ""] = row.key.split(":");
      if (prefix === "city") return { id: "-", name: "-", city: rest, type: "-" };
      if (prefix === "type") return { id: "-", name: "-", city: "-", type: rest };
      return { id: row.key, name: "-", city: "-", type: "-" };
    });
    for (const place of allRowsAsPlaces) {
      for (const url of urlsOf(mustPhoto(place))) {
        const path = `${PUBLIC}${url}`;
        expect(existsSync(path), url).toBe(true);
        const head = readFileSync(path).subarray(0, 2);
        expect([...head], url).toEqual([0xff, 0xd8]);
      }
    }
  });

  it("has no file under public/photos that no curated photo uses", () => {
    const used = rows.flatMap((row) => [
      `${fileStem(row.key)}-500.jpg`,
      `${fileStem(row.key)}-960.jpg`,
    ]);
    expect(readdirSync(`${PUBLIC}/photos`).sort()).toEqual(used.sort());
  });
});

describe("scripts/fetch-place-photos.ts", () => {
  it("allows CC0, public domain, CC BY and CC BY-SA, and nothing else", () => {
    for (const license of [
      "CC0",
      "Public domain",
      "CC BY 2.0",
      "CC BY-SA 4.0",
      "CC BY-SA 3.0 de",
      "CC BY-SA 3.0 igo",
    ]) {
      expect(isAllowedLicense(license), license).toBe(true);
    }
    for (const license of [
      "CC BY-NC 2.0",
      "CC BY-NC-SA 4.0",
      "CC BY-ND 3.0",
      "GFDL",
      "All rights reserved",
      "",
    ]) {
      expect(isAllowedLicense(license), license).toBe(false);
    }
  });

  it("credits the author the way they ask, then the artist, then the uploader", () => {
    const blackcat = '<a href="//commons.wikimedia.org/wiki/User:Blackcat">Blackcat</a>';
    expect(authorOf("Sergio D’Afflitto", blackcat, "Blackcat")).toBe("Sergio D’Afflitto");
    expect(authorOf("", blackcat, "Blackcat")).toBe("Blackcat");
    expect(authorOf("", "Carlo Ferrari.", "Ninja")).toBe("Carlo Ferrari");
    expect(authorOf("", '<a href="x">. Ray in Manila</a>', "Ham II")).toBe("Ray in Manila");
    expect(authorOf("", "Tom &amp; Jerry<br>Rome", "tj")).toBe("Tom & Jerry Rome");
    const tooLong = "This photo was taken by someone who wrote a long note about how to credit it";
    expect(authorOf("", tooLong, "Moroder")).toBe("Moroder");
    expect(authorOf("", "", "Uploader")).toBe("Uploader");
  });

  it("names files the way the page asks for them", () => {
    expect(fileStem("place_001")).toBe("place_001");
    expect(fileStem("city:Isola della Scala")).toBe("city-isola-della-scala");
    expect(fileStem("type:historic_site")).toBe("type-historic_site");
  });

  it("reads the size of a downloaded JPEG and rejects other bytes", () => {
    const bytes = readFileSync(`${PUBLIC}/photos/place_001-960.jpg`);
    expect(jpegSize(bytes)?.width).toBe(960);
    expect(jpegSize(Buffer.from("<html>not a photo</html>"))).toBeNull();
  });
});

describe("HIGHLIGHT_PLACE_IDS", () => {
  it("lists 6 to 8 distinct places with their own photos, from at least four cities", () => {
    expect(HIGHLIGHT_PLACE_IDS.length).toBeGreaterThanOrEqual(6);
    expect(HIGHLIGHT_PLACE_IDS.length).toBeLessThanOrEqual(8);
    expect(new Set(HIGHLIGHT_PLACE_IDS).size).toBe(HIGHLIGHT_PLACE_IDS.length);
    const cities = new Set<string>();
    for (const id of HIGHLIGHT_PLACE_IDS) {
      const place = rawPlaces.find((candidate) => candidate.id === id);
      expect(place, id).toBeDefined();
      expect(placeHasOwnPhoto(id), id).toBe(true);
      if (place) cities.add(place.city);
    }
    expect(cities.size).toBeGreaterThanOrEqual(4);
  });
});
