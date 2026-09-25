import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DayMap,
  MAP_UNAVAILABLE,
  MapBoundary,
  MapUnavailable,
  prefetchMap,
  withMapFallback,
} from "../components/DayMap";
import DayMapInner from "../components/DayMapInner";
import { easeOutExpo } from "../components/map/camera";
import { MARKER_MAX_NUDGE, MARKER_MIN_GAP, spreadOffsets } from "../components/map/spread";
import { lngLatBounds, type MapPoint, mapPoints, routeData } from "../lib/mapPoints";
import { PALETTES } from "../lib/mapStyle";
import { buildTripView } from "../lib/timetable";
import * as fake from "./fakeMapLibre";
import { lastMap } from "./fakeMapLibre";
import { ctx, fixturePlan, must } from "./fixtures";

// The map is optional. A failed chunk load, a browser without WebGL 2 or a MapLibre error must
// stay inside the map frame; before this, one dropped request replaced the whole page, plan and
// all, with Next's error screen. jsdom has no WebGL, so MapLibre is replaced by a stand-in that
// records what the component asks of it and puts markers in the DOM the way MapLibre does
// (test/fakeMapLibre.ts).

vi.mock("maplibre-gl", async () => (await import("./fakeMapLibre")).maplibre);

function dayPoints(index: number): MapPoint[] {
  return mapPoints(must(fixturePlan().days[index]), ctx);
}

/** DayMapInner with the day's other props filled in; only the stops matter here. */
function Inner({ points }: { points: readonly MapPoint[] }) {
  return (
    <DayMapInner
      points={points}
      title="Day 1, Tue 6 Oct, Rome"
      days={[]}
      active={0}
      onSelectDay={() => {}}
      onDetails={() => {}}
    />
  );
}

function markerNumbers(container: HTMLElement): string[] {
  return [...container.querySelectorAll(".map-stop-button .map-marker")].map(
    (marker) => marker.textContent ?? "",
  );
}

/** The elements MapLibre moves for each stop (a marker's own element). */
function markerHosts(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(".map-stop")].map(
    (stop) => stop.parentElement as HTMLElement,
  );
}

beforeEach(() => {
  fake.resetFake();
  vi.stubGlobal("WebGL2RenderingContext", class {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("DayMap fallbacks", () => {
  it("shows a notice instead of crashing the page when the map code fails to load", async () => {
    const loaded = await withMapFallback(() =>
      Promise.reject(new Error("Failed to load chunk /_next/static/chunks/x.js")),
    );
    expect(loaded.default).toBe(MapUnavailable);
    render(<MapUnavailable points={[]} />);
    expect(screen.getByTestId("map-unavailable").textContent).toBe(MAP_UNAVAILABLE);
  });

  it("uses the real map when its code loads", async () => {
    const Real = () => <p>map</p>;
    const loaded = await withMapFallback(async () => ({ default: Real }));
    expect(loaded.default).toBe(Real);
  });

  it("keeps an error thrown while drawing the map inside the map frame", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const Broken = () => {
      throw new Error("MapLibre could not draw");
    };
    render(
      <main>
        <p>Timetable</p>
        <MapBoundary>
          <Broken />
        </MapBoundary>
      </main>,
    );
    expect(screen.getByText("Timetable")).toBeTruthy();
    expect(screen.getByTestId("map-unavailable")).toBeTruthy();
  });

  it("fetches the map code at idle time and cancels a fetch not yet started", () => {
    const request = vi.fn((_run: () => void) => 7);
    const cancel = vi.fn();
    vi.stubGlobal("requestIdleCallback", request);
    vi.stubGlobal("cancelIdleCallback", cancel);
    const stop = prefetchMap();
    expect(request).toHaveBeenCalledOnce();
    stop();
    expect(cancel).toHaveBeenCalledWith(7);
  });

  it("shows the notice when the browser has no WebGL 2", () => {
    vi.stubGlobal("WebGL2RenderingContext", undefined);
    render(<Inner points={dayPoints(0)} />);
    expect(screen.getByTestId("map-unavailable").textContent).toBe(MAP_UNAVAILABLE);
    expect(fake.state.maps).toHaveLength(0);
  });

  it("shows the notice when MapLibre cannot create its WebGL context", () => {
    fake.state.throwOnCreate = true;
    render(<Inner points={dayPoints(0)} />);
    expect(screen.getByTestId("map-unavailable")).toBeTruthy();
  });
});

/** The page's DayMap on one day of the fixture plan (or on `days` when given). */
function renderDayMap(days = buildTripView(fixturePlan(), ctx, []), active = 0) {
  const props = { ctx, onSelectDay: vi.fn(), onDetails: vi.fn() };
  const utils = render(<DayMap days={days} active={active} {...props} />);
  return {
    ...utils,
    show: (next: typeof days, index = active) =>
      utils.rerender(<DayMap days={next} active={index} {...props} />),
  };
}

describe("DayMap while its code loads", () => {
  it("fills the map's own frame with a skeleton, so nothing moves when the map draws", () => {
    renderDayMap();
    const skeleton = screen.getByTestId("map-skeleton");
    expect(skeleton.classList.contains("skeleton--fill")).toBe(true);
    // Inside the fixed-height frame, hidden from screen readers (the list is the map's text
    // equivalent), and never a "Loading map" line that reads as page content.
    expect(skeleton.closest(".map-frame")).toBeTruthy();
    expect(skeleton.getAttribute("aria-hidden")).toBe("true");
    expect(screen.queryByText("Loading map")).toBeNull();
  });

  it("credits OpenStreetMap and Protomaps with links under the map", () => {
    renderDayMap();
    const osm = screen.getByRole("link", { name: "OpenStreetMap contributors" });
    expect(osm.getAttribute("href")).toBe("https://www.openstreetmap.org/copyright");
    expect(screen.getByRole("link", { name: "Protomaps" }).getAttribute("href")).toBe(
      "https://protomaps.com",
    );
  });

  it("explains the dashed marker only on a day with an approximate location", () => {
    const days = buildTripView(fixturePlan(), ctx, []);
    const { show } = renderDayMap(days);
    expect(screen.queryByText(/dashed circle/)).toBeNull();
    // place_059 (Brera Antique Market) has a repaired location.
    const view = must(days[0]);
    const day = { ...view.day, stops: [{ ...must(view.day.stops[0]), placeId: "place_059" }] };
    show([{ ...view, day }, ...days.slice(1)]);
    expect(screen.getByText(/A dashed circle marks an approximate location\./)).toBeTruthy();
  });

  it("names the map's day in its screen reader line", () => {
    renderDayMap(buildTripView(fixturePlan(), ctx, []), 1);
    expect(screen.getByText(/^Map of day 2\./)).toBeTruthy();
  });
});

describe("DayMapInner", () => {
  it("draws one numbered marker per stop, in visiting order", () => {
    fake.stubMedia();
    const points = dayPoints(0);
    const { container } = render(<Inner points={points} />);
    expect(markerNumbers(container)).toEqual(points.map((point) => String(point.number)));
    const approximate: MapPoint = { ...must(points[0]), approximate: true };
    cleanup();
    const second = render(<Inner points={[approximate]} />);
    const marker = second.container.querySelector(".map-marker");
    expect(marker?.classList.contains("map-marker--approximate")).toBe(true);
  });

  it("draws earlier stops above later ones, so the first stop is never hidden", () => {
    fake.stubMedia();
    const points = dayPoints(0);
    const { container } = render(<Inner points={points} />);
    const layers = markerHosts(container).map((host) => Number(host.style.zIndex));
    expect(layers).toHaveLength(points.length);
    expect(layers).toEqual([...layers].sort((a, b) => b - a));
    expect(new Set(layers).size).toBe(layers.length);
  });

  it("nudges stops that would overlap apart, and eases them back as the map zooms in", () => {
    fake.stubMedia();
    const base = must(dayPoints(0)[0]);
    // Two stops about 5 m apart: 5 px on screen at this scale, so the discs would cover each other.
    const points: MapPoint[] = [
      base,
      { ...base, number: 2, placeId: "near", lng: base.lng + 0.00005 },
    ];
    const { container } = render(<Inner points={points} />);
    const offsets = () => markerHosts(container).map((host) => host.dataset.offset);
    expect(offsets()).toEqual(["-8.5,0", "8.5,0"]);
    fake.state.scale = 1_000_000; // zoomed in: 50 px apart, room for both
    act(() => lastMap().emit("zoom"));
    expect(offsets()).toEqual(["0,0", "0,0"]);
  });

  it("opens framed on the day's stops, without a camera move", () => {
    fake.stubMedia();
    const points = dayPoints(0);
    render(<Inner points={points} />);
    const map = lastMap();
    expect(map.options.bounds).toEqual(lngLatBounds(points));
    expect(map.options.fitBoundsOptions).toEqual({ padding: 40, maxZoom: 15 });
    expect(map.options.cooperativeGestures).toBe(true);
    expect(map.fitBounds).not.toHaveBeenCalled();
    expect(map.setStyle).not.toHaveBeenCalled();
  });

  it("glides to the next day's stops over 700 ms and redraws its route and markers", () => {
    fake.stubMedia();
    const { container, rerender } = render(<Inner points={dayPoints(0)} />);
    const next = dayPoints(1);
    rerender(<Inner points={next} />);
    const map = lastMap();
    expect(map.fitBounds).toHaveBeenCalledWith(lngLatBounds(next), {
      padding: { top: 40, right: 40, bottom: 40, left: 40 },
      maxZoom: 15,
      duration: 700,
      easing: easeOutExpo,
    });
    const style = map.setStyle.mock.calls.at(-1)?.[0];
    expect(style.sources.route).toEqual({ type: "geojson", data: routeData(next) });
    expect(markerNumbers(container)).toEqual(next.map((point) => String(point.number)));
  });

  it("jumps to the new stops without animation when the traveler prefers reduced motion", () => {
    fake.stubMedia({ reduced: true });
    const { rerender } = render(<Inner points={dayPoints(0)} />);
    const next = dayPoints(1);
    rerender(<Inner points={next} />);
    const [bounds, options] = lastMap().fitBounds.mock.calls.at(-1) ?? [];
    expect(bounds).toEqual(lngLatBounds(next));
    expect(options).toEqual({
      padding: { top: 40, right: 40, bottom: 40, left: 40 },
      maxZoom: 15,
      animate: false,
    });
  });

  it("follows the system colour scheme live, basemap and markers together", () => {
    const media = fake.stubMedia({ dark: false }, (run) => act(run));
    const { container } = render(<Inner points={dayPoints(0)} />);
    const canvas = container.querySelector<HTMLElement>(".map-canvas");
    expect(canvas?.style.getPropertyValue("--map-ink")).toBe(PALETTES.light.ink);
    media.setDark(true);
    const style = lastMap().setStyle.mock.calls.at(-1)?.[0];
    expect(style.layers[0].paint).toEqual({ "background-color": PALETTES.dark.land });
    expect(canvas?.style.getPropertyValue("--map-ink")).toBe(PALETTES.dark.ink);
    expect(canvas?.style.getPropertyValue("--map-paper")).toBe(PALETTES.dark.paper);
  });

  it("swallows tile and glyph errors, and still logs any other error", () => {
    fake.stubMedia();
    render(<Inner points={dayPoints(0)} />);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const map = lastMap();
    map.emit("error", { sourceId: "basemap", error: new Error("Failed to fetch") });
    expect(log).not.toHaveBeenCalled();
    const bug = new Error("Invalid style");
    map.emit("error", { error: bug });
    expect(log).toHaveBeenCalledWith(bug);
  });

  it("shows the notice, and logs nothing, when MapLibre's worker cannot load", () => {
    fake.stubMedia();
    render(<Inner points={dayPoints(0)} />);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    // MapLibre's own message when the worker file fails to load (offline, or a dropped request).
    const failed = new Error("Worker failed to load. Check that the worker URL is correct.");
    act(() => lastMap().emit("error", { error: failed }));
    expect(screen.getByTestId("map-unavailable").textContent).toBe(MAP_UNAVAILABLE);
    expect(log).not.toHaveBeenCalled();
  });

  it("sets up the worker and the tile archive once, and rounds the basemap's tile zoom", () => {
    fake.stubMedia();
    render(<Inner points={dayPoints(0)} />);
    render(<Inner points={dayPoints(1)} />);
    expect(fake.workerUrls).toEqual([
      `${window.location.origin}/map/maplibre/maplibre-gl-worker.mjs`,
    ]);
    expect(fake.protocols).toEqual(["pmtiles"]);
    lastMap().emit("styledata");
    expect(fake.basemap.roundZoom).toBe(true);
  });

  it("keeps its credits compact and folded, and nothing of its own in the tab order", () => {
    fake.stubMedia();
    const { container, unmount } = render(<Inner points={dayPoints(0)} />);
    const map = lastMap();
    const control = map.addControl.mock.calls[0] as unknown as [{ options: unknown }];
    expect(control[0].options).toEqual({
      compact: true,
      customAttribution: "© OpenStreetMap contributors · Protomaps",
    });
    expect(container.querySelector("details")?.classList.contains("maplibregl-compact-show")).toBe(
      false,
    );
    expect(container.querySelector("summary")?.getAttribute("tabindex")).toBe("-1");
    expect(container.querySelector("canvas")?.getAttribute("tabindex")).toBe("-1");
    // The drawing and its controls are hidden from screen readers; the stops are not.
    expect(container.querySelector("canvas")?.getAttribute("aria-hidden")).toBe("true");
    const controls = container.querySelector(".maplibregl-control-container");
    expect(controls?.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector(".map-stop")?.closest("[aria-hidden]")).toBeNull();
    unmount();
    expect(map.remove).toHaveBeenCalledOnce();
    expect(document.querySelector(".map-canvas")).toBeNull();
  });
});

describe("spreadOffsets", () => {
  it("leaves discs that are already clear of each other where they are", () => {
    expect(
      spreadOffsets([
        { x: 0, y: 0 },
        { x: MARKER_MIN_GAP, y: 0 },
        { x: 0, y: 40 },
      ]),
    ).toEqual([
      [0, 0],
      [0, 0],
      [0, 0],
    ]);
  });

  it("pushes two close discs apart along the line between them, half each", () => {
    expect(
      spreadOffsets([
        { x: 100, y: 100 },
        { x: 100, y: 110 },
      ]),
    ).toEqual([
      [0, -6],
      [0, 6],
    ]);
  });

  it("separates stops on the exact same spot the same way every time", () => {
    const same = [
      { x: 50, y: 50 },
      { x: 50, y: 50 },
    ];
    const first = spreadOffsets(same);
    expect(first).toEqual(spreadOffsets(same));
    const [a, b] = first as [[number, number], [number, number]];
    expect(Math.hypot(b[0] - a[0], b[1] - a[1])).toBeGreaterThanOrEqual(MARKER_MIN_GAP - 1);
  });

  it("never moves a disc further than the nudge limit, even in a crowd", () => {
    const crowd = Array.from({ length: 6 }, (_, index) => ({ x: index * 2, y: index }));
    for (const [x, y] of spreadOffsets(crowd)) {
      expect(Math.hypot(x, y)).toBeLessThanOrEqual(MARKER_MAX_NUDGE + 0.5);
    }
  });

  it("keeps every number readable in the phone review's cluster of stops 1, 3 and 6", () => {
    // Stop 1 sat under stops 6 and 3, their centres 6 to 9 px apart.
    const cluster = [
      { x: 120, y: 140 },
      { x: 20, y: 30 },
      { x: 128, y: 136 },
      { x: 200, y: 60 },
      { x: 60, y: 200 },
      { x: 114, y: 146 },
    ];
    const moved = spreadOffsets(cluster).map(([x, y], index) => ({
      x: (cluster[index] as { x: number }).x + x,
      y: (cluster[index] as { y: number }).y + y,
    }));
    for (const i of [0, 2, 5]) {
      for (const j of [0, 2, 5]) {
        if (i >= j) continue;
        const a = moved[i] as { x: number; y: number };
        const b = moved[j] as { x: number; y: number };
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(MARKER_MIN_GAP - 1);
      }
    }
  });
});
