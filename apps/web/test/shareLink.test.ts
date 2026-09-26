import { type Itinerary, placesOfAnchor, validationErrors } from "@italy/planner";
import { describe, expect, it } from "vitest";
import { fromBase64Url, toBase64Url } from "../lib/base64url";
import {
  decodeShare,
  encodeShare,
  readShareParam,
  SHARE_MAX_CHARS,
  SHARE_NOTES,
  type ShareDecode,
  sharePayload,
  shareUrl,
} from "../lib/shareLink";
import { baseRequest, ctx, fixturePlan, GENERATED_AT, makeRequest, XSS } from "./fixtures";

// F9: tampered or stale share links. Whatever is in ?p=, decoding ends in a safe result with a
// visible note, never a throw, never an invalid plan, never injected text.

const encode = (value: unknown) => toBase64Url(JSON.stringify(value));
const decode = (param: string | null) => decodeShare(param, ctx, GENERATED_AT);

function payloadOf(plan: Itinerary) {
  return sharePayload(plan);
}

function expectPlan(result: ShareDecode): Itinerary {
  expect(result.status).toBe("plan");
  if (result.status !== "plan") throw new Error("not a plan");
  expect(validationErrors(result.itinerary, ctx)).toEqual([]);
  return result.itinerary;
}

describe("round trip", () => {
  it("reopens the same places in the same order on the same days", () => {
    const plan = fixturePlan({ pace: "packed", interests: ["art", "views"] });
    const reopened = expectPlan(decode(encodeShare(plan)));
    expect(reopened.days.map((day) => day.stops.map((stop) => stop.placeId))).toEqual(
      plan.days.map((day) => day.stops.map((stop) => stop.placeId)),
    );
    expect(reopened.days.map((day) => day.stops.map((stop) => stop.start))).toEqual(
      plan.days.map((day) => day.stops.map((stop) => stop.start)),
    );
    expect(reopened.request).toEqual(plan.request);
  });

  it("keeps private notes out of the link", () => {
    const plan = { ...fixturePlan(), request: { ...makeRequest(), notes: "our anniversary" } };
    const param = encodeShare(plan);
    expect(fromBase64Url(param)).not.toContain("anniversary");
    expect(sharePayload(plan).request).not.toHaveProperty("notes");
    expect(expectPlan(decode(param)).request.notes).toBeUndefined();
  });

  it("builds a URL with the plan in ?p= and reads it back", () => {
    const plan = fixturePlan();
    const url = new URL(shareUrl(plan, "https://italy-planner.brdjx.com/"));
    expect(readShareParam(url.search)).toBe(encodeShare(plan));
    expect(url.toString().length).toBeLessThan(2000);
    expect(readShareParam("?other=1")).toBeNull();
  });

  it("says the times were worked out again", () => {
    expect(decode(encodeShare(fixturePlan()))).toMatchObject({ note: SHARE_NOTES.opened });
  });
});

describe("hostile or broken links", () => {
  it("returns nothing and no note when there is no link", () => {
    expect(decode(null)).toEqual({ status: "none" });
    expect(decode("")).toEqual({ status: "none" });
  });

  it("rejects malformed base64 with a note", () => {
    for (const param of ["%%%", "abc$def", "a", "abcde", "====", "a b c"]) {
      expect(decode(param)).toEqual({ status: "invalid", note: SHARE_NOTES.damaged });
    }
  });

  it("rejects bytes that are not UTF-8", () => {
    const param = btoa(String.fromCharCode(0xff, 0xfe, 0xfd))
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
    expect(decode(param)).toEqual({ status: "invalid", note: SHARE_NOTES.damaged });
  });

  it("rejects text that is not JSON, or JSON of the wrong shape", () => {
    const shapes = ["{not json", "null", "42", '"text"', "[]", "{}"];
    for (const text of shapes) {
      expect(decode(toBase64Url(text))).toEqual({ status: "invalid", note: SHARE_NOTES.damaged });
    }
    const extra = { ...payloadOf(fixturePlan()), admin: true };
    expect(decode(encode(extra)).status).toBe("invalid");
    const twoDays = {
      ...payloadOf(fixturePlan()),
      days: payloadOf(fixturePlan()).days.slice(0, 2),
    };
    expect(decode(encode(twoDays)).status).toBe("invalid");
  });

  it("rejects links from another version, even one that looks close", () => {
    for (const v of [2, 0, "1", null]) {
      expect(decode(encode({ ...payloadOf(fixturePlan()), v }))).toEqual({
        status: "invalid",
        note: SHARE_NOTES.version,
      });
    }
  });

  it("refuses an oversized link before decoding it", () => {
    const huge = "A".repeat(SHARE_MAX_CHARS + 1);
    expect(decode(huge)).toEqual({ status: "invalid", note: SHARE_NOTES.tooLong });
  });

  it("rejects ids carrying markup, since ids are letters, digits, _ and - only", () => {
    const payload = payloadOf(fixturePlan());
    const tampered = {
      ...payload,
      days: payload.days.map((day, index) => (index === 0 ? { ...day, ids: [XSS] } : day)),
    };
    expect(decode(encode(tampered))).toEqual({ status: "invalid", note: SHARE_NOTES.damaged });
  });

  it("drops unknown interests, including markup, and says settings changed", () => {
    const payload = payloadOf(fixturePlan());
    const tampered = { ...payload, request: { ...payload.request, interests: ["food", XSS] } };
    const result = decode(encode(tampered));
    const plan = expectPlan(result);
    expect(plan.request.interests).toEqual(["food"]);
    expect(result.status === "plan" && result.note).toContain("no longer offered");
  });
});

describe("stale links", () => {
  it("leaves out places that are no longer in the data and counts them", () => {
    const payload = payloadOf(fixturePlan());
    const tampered = {
      ...payload,
      days: payload.days.map((day) => ({ ...day, ids: [...day.ids, "place_gone"] })),
    };
    const result = decode(encode(tampered));
    expectPlan(result);
    expect(result.status === "plan" && result.note).toContain("3 stops from the link");
  });

  it("leaves out a place the traveler excluded, and duplicates across days", () => {
    const plan = fixturePlan();
    const payload = payloadOf(plan);
    const firstId = payload.days[0]?.ids[0] as string;
    const excluded = { ...payload, request: { ...payload.request, exclude: [firstId] } };
    const reopened = expectPlan(decode(encode(excluded)));
    expect(reopened.days.flatMap((day) => day.stops.map((stop) => stop.placeId))).not.toContain(
      firstId,
    );
    const dup = {
      ...payload,
      days: payload.days.map((day, index) =>
        index === 1 ? { ...day, ids: [firstId, ...day.ids] } : day,
      ),
    };
    const deduped = expectPlan(decode(encode(dup)));
    const all = deduped.days.flatMap((day) => day.stops.map((stop) => stop.placeId));
    expect(new Set(all).size).toBe(all.length);
  });

  it("leaves out a place from another base instead of showing an impossible day", () => {
    const payload = payloadOf(fixturePlan());
    const milan = placesOfAnchor(ctx, "milan")[0]?.id as string;
    const tampered = {
      ...payload,
      days: payload.days.map((day, index) =>
        index === 0 ? { ...day, ids: [milan, ...day.ids] } : day,
      ),
    };
    const plan = expectPlan(decode(encode(tampered)));
    expect(plan.days[0]?.stops.map((stop) => stop.placeId)).not.toContain(milan);
  });

  it("leaves out a seasonal place on a date it is closed", () => {
    // place_035 (Chianti by bike, a Florence day trip) is open April to October only.
    const plan = fixturePlan({ startDate: "2027-01-12", anchors: ["florence"] });
    const payload = payloadOf(plan);
    const tampered = {
      ...payload,
      days: payload.days.map((day, index) =>
        index === 0 ? { ...day, ids: ["place_035", ...day.ids] } : day,
      ),
    };
    const result = decode(encode(tampered));
    const reopened = expectPlan(result);
    const firstDay = reopened.days[0]?.stops.map((stop) => stop.placeId);
    expect(firstDay).not.toContain("place_035");
    expect(firstDay).toEqual(payload.days[0]?.ids);
    expect(result.status === "plan" && result.note).toContain("1 stop from the link");
  });

  it("falls back to the trip settings when a base is unknown", () => {
    const payload = payloadOf(fixturePlan());
    const tampered = {
      ...payload,
      days: payload.days.map((day, index) =>
        index === 2 ? { ...day, anchorId: "atlantis" } : day,
      ),
    };
    const result = decode(encode(tampered));
    expect(result.status).toBe("request");
    expect(result.status === "request" && result.request.startDate).toBe(baseRequest.startDate);
    expect(result.status === "request" && result.note).toBe(SHARE_NOTES.stale);
  });

  it("falls back to the trip settings when a day ends up empty", () => {
    const payload = payloadOf(fixturePlan());
    const tampered = {
      ...payload,
      days: payload.days.map((day, index) => (index === 1 ? { ...day, ids: ["place_gone"] } : day)),
    };
    expect(decode(encode(tampered)).status).toBe("request");
  });

  it("opens a trip with a city a day as the plan", () => {
    const payload = payloadOf(fixturePlan());
    const bases = ["rome", "florence", "venice"];
    const tampered = {
      ...payload,
      days: bases.map((anchorId) => ({
        anchorId,
        ids: placesOfAnchor(ctx, anchorId)
          .slice(0, 1)
          .map((p) => p.id),
      })),
    };
    // A route the traveler set by hand may give every day its own city (decision 16).
    const opened = decode(encode(tampered));
    expect(opened.status).toBe("plan");
    expect(opened.status === "plan" && opened.itinerary.days.map((day) => day.anchorId)).toEqual(
      bases,
    );
  });

  it("drops a must-see that the link's days leave out", () => {
    const payload = payloadOf(fixturePlan());
    const unused = placesOfAnchor(ctx, "rome").find(
      (candidate) => !payload.days.some((day) => day.ids.includes(candidate.id)),
    );
    const tampered = {
      ...payload,
      request: { ...payload.request, mustInclude: [unused?.id as string] },
    };
    const plan = expectPlan(decode(encode(tampered)));
    expect(plan.request.mustInclude).toEqual([]);
  });
});
