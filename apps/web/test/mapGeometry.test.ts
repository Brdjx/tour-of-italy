import { describe, expect, it } from "vitest";
import {
  flipFrames,
  POPUP_EDGE,
  POPUP_GAP,
  placePopup,
  reachesZone,
  screenPoint,
} from "../lib/mapGeometry";

// The map's screen geometry: where a stop lands for a camera (to keep stops out from under the
// Expand pill), where a stop's popup goes, and the keyframes that grow the map to full screen
// without stretching it.

const rome = { lng: 12.4964, lat: 41.9028 };
const size = { width: 400, height: 300 };

describe("screenPoint", () => {
  it("puts the camera's centre in the middle, east to the right and north up", () => {
    const camera = { center: rome, zoom: 13 };
    expect(screenPoint(rome, camera, size)).toEqual({ x: 200, y: 150 });
    const east = screenPoint({ ...rome, lng: rome.lng + 0.01 }, camera, size);
    const north = screenPoint({ ...rome, lat: rome.lat + 0.01 }, camera, size);
    expect(east.x).toBeGreaterThan(200);
    expect(east.y).toBeCloseTo(150, 6);
    expect(north.y).toBeLessThan(150);
  });

  it("matches MapLibre's 512 px world: a degree of longitude at zoom 0 is 512/360 px", () => {
    const at = screenPoint({ lng: 1, lat: 0 }, { center: { lng: 0, lat: 0 }, zoom: 0 }, size);
    expect(at.x - 200).toBeCloseTo(512 / 360, 6);
    // One zoom level doubles every distance.
    const closer = screenPoint({ lng: 1, lat: 0 }, { center: { lng: 0, lat: 0 }, zoom: 1 }, size);
    expect(closer.x - 200).toBeCloseTo((2 * 512) / 360, 6);
  });
});

describe("reachesZone", () => {
  const camera = { center: rome, zoom: 14 };
  // A 44 px box in the top right corner, as the Expand pill is.
  const zone = { left: 348, top: 8, width: 44, height: 44 };

  it("finds a stop whose disc would reach into the box, and passes one that stays clear", () => {
    // A stop at the centre is far from the corner.
    expect(reachesZone([rome], camera, size, zone, 30)).toBe(false);
    // Move a stop to about (370, 30) on screen: inside the box.
    const scale = 512 * 2 ** 14;
    const corner = {
      lng: rome.lng + (170 / scale) * 360,
      lat: rome.lat + (120 / scale) * 360 * Math.cos((rome.lat * Math.PI) / 180),
    };
    const at = screenPoint(corner, camera, size);
    expect(at.x).toBeGreaterThan(348);
    expect(at.y).toBeLessThan(52);
    expect(reachesZone([rome, corner], camera, size, zone, 30)).toBe(true);
  });

  it("counts the disc's reach, not only its centre", () => {
    const scale = 512 * 2 ** 14;
    // 20 px below the box's bottom edge: clear of it by centre, not with a 30 px reach.
    const below = { lng: rome.lng + (170 / scale) * 360, lat: rome.lat };
    const at = screenPoint(below, camera, size);
    const nearZone = { ...zone, top: at.y - 20 - 44 };
    expect(reachesZone([below], camera, size, nearZone, 0)).toBe(false);
    expect(reachesZone([below], camera, size, nearZone, 30)).toBe(true);
  });

  it("overlaps nothing on a map that has no size yet", () => {
    expect(reachesZone([rome], camera, { width: 0, height: 0 }, zone, 30)).toBe(false);
  });
});

describe("placePopup", () => {
  const room = { width: 400, height: 300, top: 0, right: 0, bottom: 0, left: 0 };
  const popup = { width: 200, height: 90 };

  it("sits above its stop, centred, when there is room", () => {
    expect(placePopup({ x: 200, y: 200 }, popup, room)).toEqual({ side: "above", shift: 0 });
  });

  it("flips below a stop near the top, and never covers the stop", () => {
    expect(placePopup({ x: 200, y: 60 }, popup, room).side).toBe("below");
    // Either way its near edge is POPUP_GAP from the stop's centre, past the 14 px disc.
    expect(POPUP_GAP).toBe(14 + 8);
    // Just enough room above: above.
    const fits = POPUP_GAP + popup.height + POPUP_EDGE;
    expect(placePopup({ x: 200, y: fits }, popup, room).side).toBe("above");
    expect(placePopup({ x: 200, y: fits - 1 }, popup, room).side).toBe("below");
  });

  it("keeps clear of the room at the top or the bottom", () => {
    expect(placePopup({ x: 200, y: 160 }, popup, { ...room, top: 52 }).side).toBe("below");
    // No room above: below, unless the day switcher at the foot leaves even less room there.
    expect(placePopup({ x: 200, y: 110 }, popup, room).side).toBe("below");
    expect(placePopup({ x: 200, y: 110 }, popup, { ...room, bottom: 100 }).side).toBe("above");
  });

  it("keeps clear of the notch at either side", () => {
    const notched = { ...room, left: 47, right: 47 };
    const left = placePopup({ x: 60, y: 200 }, popup, notched);
    expect(60 - 100 + left.shift).toBe(47 + POPUP_EDGE);
    const right = placePopup({ x: 380, y: 200 }, popup, notched);
    expect(380 + 100 + right.shift).toBe(400 - 47 - POPUP_EDGE);
  });

  it("stays off a control on the map, such as the Expand pill", () => {
    const pill = { left: 348, top: 8, width: 44, height: 44 };
    const small = { width: 120, height: 60 };
    // Above would reach the pill's corner; below is clear.
    expect(placePopup({ x: 330, y: 110 }, small, room).side).toBe("above");
    expect(placePopup({ x: 330, y: 110 }, small, { ...room, avoid: [pill] }).side).toBe("below");
  });

  it("takes the roomier side when none fits", () => {
    const tall = { width: 200, height: 200 };
    const narrow = { ...room, width: 240 };
    expect(placePopup({ x: 120, y: 140 }, tall, narrow).side).toBe("below");
    expect(placePopup({ x: 120, y: 170 }, tall, narrow).side).toBe("above");
    // Beside the stop when that leaves less of it off the map.
    expect(placePopup({ x: 200, y: 140 }, tall, room).side).toBe("right");
  });

  it("slides sideways to stay on the map near either edge", () => {
    const left = placePopup({ x: 30, y: 200 }, popup, room);
    // Centred it would start at -70; it starts at the edge margin instead.
    expect(30 - 100 + left.shift).toBe(POPUP_EDGE);
    const right = placePopup({ x: 390, y: 200 }, popup, room);
    expect(390 + 100 + right.shift).toBe(400 - POPUP_EDGE);
  });

  it("keeps a popup wider than the map starting at the left margin", () => {
    const placed = placePopup({ x: 100, y: 200 }, { width: 500, height: 90 }, room);
    expect(placed.side).toBe("above");
    expect(100 - 250 + placed.shift).toBe(POPUP_EDGE);
  });

  describe("among the other stops and the route", () => {
    const small = { width: 120, height: 60 };
    const stop = { x: 200, y: 150 };

    it("goes beside its stop when above and below would cover other stops", () => {
      // One stop just above where the popup would sit above, one just below where it would sit
      // below: to the right is clear.
      const stops = [
        { x: 200, y: 60 },
        { x: 200, y: 240 },
      ];
      expect(placePopup(stop, small, room, { stops, route: [] })).toEqual({
        side: "right",
        shift: 0,
      });
      // With a stop to the right too, the left.
      const crowded = [...stops, { x: 300, y: 150 }];
      expect(placePopup(stop, small, room, { stops: crowded, route: [] }).side).toBe("left");
    });

    it("lines its number up with the stop's at one end rather than cover another stop", () => {
      // Centred above, it would cover a stop to the upper left; lined up at its start (its
      // number over the stop's, 21 px in) it clears it.
      const upperLeft = { stops: [{ x: 145, y: 100 }], route: [] };
      expect(placePopup(stop, small, room, upperLeft)).toEqual({ side: "above", shift: 60 - 21 });
      // Beside the stop, lined up at its end: its bottom 21 px below the stop's centre.
      const around = {
        stops: [
          { x: 200, y: 60 },
          { x: 200, y: 240 },
          { x: 300, y: 192 },
        ],
        route: [],
      };
      expect(placePopup(stop, small, room, around)).toEqual({ side: "right", shift: 21 - 30 });
    });

    it("counts a stop as covered when the popup comes within 18 px of it", () => {
      // Above, the popup spans y 68 to 128: a stop 17 px over its top edge is covered, 19 is not.
      expect(placePopup(stop, small, room, { stops: [{ x: 200, y: 51 }], route: [] }).side).toBe(
        "below",
      );
      expect(placePopup(stop, small, room, { stops: [{ x: 200, y: 49 }], route: [] }).side).toBe(
        "above",
      );
    });

    it("prefers the side that crosses fewer stretches of route", () => {
      // The route runs across where the popup would sit above: below is clear.
      const route = [
        { x: 60, y: 100 },
        { x: 340, y: 100 },
      ];
      expect(placePopup(stop, small, room, { stops: [], route }).side).toBe("below");
      // A route straight up and down through the stop crosses above and below, not the sides.
      const upright = [
        { x: 200, y: 10 },
        { x: 200, y: 290 },
      ];
      expect(placePopup(stop, small, room, { stops: [], route: upright }).side).toBe("right");
      // A stretch that ends short of the box, or runs beside it, is not crossed.
      const short = [
        { x: 60, y: 100 },
        { x: 130, y: 100 },
        { x: 130, y: 20 },
      ];
      expect(placePopup(stop, small, room, { stops: [], route: short }).side).toBe("above");
    });

    it("hides a stretch of route rather than a stop", () => {
      // A stop just below; a route that crosses where the popup would sit above, to the right
      // and to the left, once each, and never below.
      const stops = [{ x: 200, y: 240 }];
      const route = [
        { x: 100, y: 100 },
        { x: 300, y: 100 },
        { x: 300, y: 290 },
        { x: 100, y: 290 },
        { x: 100, y: 140 },
      ];
      // Above, right and left each cross one stretch: above, the first of them, wins.
      expect(placePopup(stop, small, room, { stops, route }).side).toBe("above");
    });

    it("slides a popup beside its stop up or down to stay on the map", () => {
      const placed = placePopup({ x: 60, y: 30 }, small, room, {
        stops: [{ x: 60, y: 90 }],
        route: [],
      });
      // Centred on the stop it would start at y 0; it starts at the edge margin instead.
      expect(placed).toEqual({ side: "right", shift: POPUP_EDGE });
    });
  });
});

describe("flipFrames", () => {
  const page = { left: 1000, top: 120, width: 380, height: 560 };
  const full = { left: 0, top: 72, width: 1440, height: 828 };

  /** Applies "translate(x, y) scale(a, b)" or "scale(a, b) translate(x, y)" to a point. */
  function apply(transform: string, point: { x: number; y: number }) {
    const numbers = [...transform.matchAll(/-?[\d.]+(?:e-?\d+)?/g)].map((m) => Number(m[0]));
    const [a, b, c, d] = numbers as [number, number, number, number];
    if (transform.startsWith("translate")) return { x: a + c * point.x, y: b + d * point.y };
    return { x: a * (point.x + c), y: b * (point.y + d) };
  }

  it("starts on the page's box and ends at full screen", () => {
    const { frame } = flipFrames(page, full);
    expect(frame).toHaveLength(25);
    // The frame's corners land on the page's box at the start.
    const topLeft = apply(frame[0] as string, { x: 0, y: 0 });
    const bottomRight = apply(frame[0] as string, { x: full.width, y: full.height });
    expect(full.left + topLeft.x).toBeCloseTo(page.left, 2);
    expect(full.top + topLeft.y).toBeCloseTo(page.top, 2);
    expect(full.left + bottomRight.x).toBeCloseTo(page.left + page.width, 1);
    expect(full.top + bottomRight.y).toBeCloseTo(page.top + page.height, 1);
    expect(frame.at(-1)).toBe("translate(0px, 0px) scale(1, 1)");
  });

  it("holds the map at its real size, centred in the growing window, at every step", () => {
    const { frame, inner } = flipFrames(page, full);
    frame.forEach((step, index) => {
      const held = inner[index] as string;
      // A map point's screen position: through the inner transform, then the frame's.
      const at = (x: number, y: number) => apply(step, apply(held, { x, y }));
      const a = at(0, 0);
      const b = at(100, 50);
      // Never stretched: 100 px across and 50 px down stay 100 and 50.
      expect(b.x - a.x).toBeCloseTo(100, 1);
      expect(b.y - a.y).toBeCloseTo(50, 1);
      // The map's middle sits in the middle of the window.
      const middle = at(full.width / 2, full.height / 2);
      const window = apply(step, { x: full.width / 2, y: full.height / 2 });
      expect(middle.x).toBeCloseTo(window.x, 1);
      expect(middle.y).toBeCloseTo(window.y, 1);
    });
    expect(inner.at(-1)).toBe("scale(1, 1) translate(0px, 0px)");
  });

  it("survives a box with no size", () => {
    const { frame, inner } = flipFrames({ left: 0, top: 0, width: 0, height: 0 }, full, 2);
    expect(frame).toHaveLength(3);
    expect(inner.every((step) => !step.includes("Infinity") && !step.includes("NaN"))).toBe(true);
  });
});
