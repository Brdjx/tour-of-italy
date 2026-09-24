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
import { lngLatBounds, type MapPoint, mapPoints, routeData } from "../lib/mapPoints";
import { PALETTES } from "../lib/mapStyle";
import { ctx, fixturePlan, must } from "./fixtures";

// The map is optional. A failed chunk load, a browser without WebGL 2 or a MapLibre error must
// stay inside the map frame; before this, one dropped request replaced the whole page, plan and
// all, with Next's error screen. jsdom has no WebGL, so MapLibre is replaced by a stand-in that
// records what the component asks of it and puts markers in the DOM the way MapLibre does.

type Handler = (event: Record<string, unknown>) => void;

const fake = vi.hoisted(() => {
  const state = { throwOnCreate: false, maps: [] as FakeMap[] };
  const basemap: { roundZoom?: boolean } = {};

  class FakeMap {
    options: Record<string, unknown>;
    container: HTMLElement;
    handlers = new Map<string, Handler[]>();
    fitBounds = vi.fn();
    setStyle = vi.fn();
    remove = vi.fn();
    touchZoomRotate = { disableRotation: vi.fn() };
    getSource = vi.fn((id: string) => (id === "basemap" ? basemap : undefined));
    constructor(options: Record<string, unknown>) {
      if (state.throwOnCreate) throw new Error("Could not create a WebGL2 context");
      this.options = options;
      this.container = options.container as HTMLElement;
      const canvas = document.createElement("canvas");
      canvas.setAttribute("tabindex", "0");
      this.container.append(canvas);
      state.maps.push(this);
    }
    on(type: string, handler: Handler) {
      this.handlers.set(type, [...(this.handlers.get(type) ?? []), handler]);
      return this;
    }
    emit(type: string, event: Record<string, unknown> = {}) {
      for (const handler of this.handlers.get(type) ?? []) handler(event);
    }
    addControl = vi.fn(() => {
      // MapLibre's compact attribution: a details element, open, with its toggle.
      const details = document.createElement("details");
      details.className = "maplibregl-ctrl-attrib maplibregl-compact maplibregl-compact-show";
      details.append(document.createElement("summary"));
      this.container.append(details);
    });
  }

  class FakeMarker {
    element: HTMLElement;
    lngLat: [number, number] | null = null;
    constructor(options: { element: HTMLElement }) {
      this.element = options.element;
    }
    setLngLat(lngLat: [number, number]) {
      this.lngLat = lngLat;
      return this;
    }
    addTo(map: FakeMap) {
      map.container.append(this.element);
      return this;
    }
    remove() {
      this.element.remove();
    }
  }

  class FakeAttribution {
    constructor(public options: Record<string, unknown>) {}
  }

  // Plain arrays, not vi.fn(): the setup runs once per test file, and restoring mocks between
  // tests would clear a spy's record of it.
  const workerUrls: string[] = [];
  const protocols: string[] = [];
  return {
    state,
    basemap,
    FakeMap,
    FakeMarker,
    FakeAttribution,
    workerUrls,
    protocols,
    setWorkerUrl: (url: string) => workerUrls.push(url),
    addProtocol: (name: string) => protocols.push(name),
  };
});

vi.mock("maplibre-gl", () => ({
  Map: fake.FakeMap,
  Marker: fake.FakeMarker,
  AttributionControl: fake.FakeAttribution,
  setWorkerUrl: fake.setWorkerUrl,
  addProtocol: fake.addProtocol,
}));

/** matchMedia for the colour scheme and reduced motion, with a way to flip the scheme. */
function stubMedia(initial: { dark?: boolean; reduced?: boolean } = {}) {
  const state = { dark: initial.dark ?? false, reduced: initial.reduced ?? false };
  const listeners = new Set<() => void>();
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() {
      if (query.includes("color-scheme: dark")) return state.dark;
      if (query.includes("reduced-motion: reduce")) return state.reduced;
      return false;
    },
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
  }));
  return {
    setDark(dark: boolean) {
      state.dark = dark;
      act(() => {
        for (const listener of listeners) listener();
      });
    },
  };
}

function dayPoints(index: number): MapPoint[] {
  return mapPoints(must(fixturePlan().days[index]), ctx);
}

function lastMap() {
  const map = fake.state.maps.at(-1);
  if (!map) throw new Error("No map was created");
  return map;
}

function markerNumbers(container: HTMLElement): string[] {
  return [...container.querySelectorAll(".map-marker")].map((marker) => marker.textContent ?? "");
}

beforeEach(() => {
  fake.state.throwOnCreate = false;
  fake.state.maps.length = 0;
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
    render(<loaded.default points={[]} />);
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
    render(<DayMapInner points={dayPoints(0)} />);
    expect(screen.getByTestId("map-unavailable").textContent).toBe(MAP_UNAVAILABLE);
    expect(fake.state.maps).toHaveLength(0);
  });

  it("shows the notice when MapLibre cannot create its WebGL context", () => {
    fake.state.throwOnCreate = true;
    render(<DayMapInner points={dayPoints(0)} />);
    expect(screen.getByTestId("map-unavailable")).toBeTruthy();
  });
});

describe("DayMap while its code loads", () => {
  it("fills the map's own frame with a skeleton, so nothing moves when the map draws", () => {
    const plan = fixturePlan();
    render(<DayMap day={must(plan.days[0])} dayNumber={1} ctx={ctx} />);
    const skeleton = screen.getByTestId("map-skeleton");
    expect(skeleton.classList.contains("skeleton--fill")).toBe(true);
    // Inside the fixed-height frame, which is hidden from screen readers (the list is the map's
    // text equivalent), and never a "Loading map" line that reads as page content.
    const frame = skeleton.closest(".map-frame");
    expect(frame?.getAttribute("aria-hidden")).toBe("true");
    expect(screen.queryByText("Loading map")).toBeNull();
  });

  it("credits OpenStreetMap and Protomaps with links under the map", () => {
    render(<DayMap day={must(fixturePlan().days[0])} dayNumber={1} ctx={ctx} />);
    const osm = screen.getByRole("link", { name: "OpenStreetMap contributors" });
    expect(osm.getAttribute("href")).toBe("https://www.openstreetmap.org/copyright");
    expect(screen.getByRole("link", { name: "Protomaps" }).getAttribute("href")).toBe(
      "https://protomaps.com",
    );
  });

  it("explains the dashed marker only on a day with an approximate location", () => {
    const day = must(fixturePlan().days[0]);
    const { rerender } = render(<DayMap day={day} dayNumber={1} ctx={ctx} />);
    expect(screen.queryByText(/dashed circle/)).toBeNull();
    // place_059 (Brera Antique Market) has a repaired location.
    const brera = { ...day, stops: [{ ...must(day.stops[0]), placeId: "place_059" }] };
    rerender(<DayMap day={brera} dayNumber={1} ctx={ctx} />);
    expect(screen.getByText(/A dashed circle marks an approximate location\./)).toBeTruthy();
  });
});

describe("DayMapInner", () => {
  it("draws one numbered marker per stop, in visiting order", () => {
    stubMedia();
    const points = dayPoints(0);
    const { container } = render(<DayMapInner points={points} />);
    expect(markerNumbers(container)).toEqual(points.map((point) => String(point.number)));
    const approximate: MapPoint = { ...must(points[0]), approximate: true };
    cleanup();
    const second = render(<DayMapInner points={[approximate]} />);
    const marker = second.container.querySelector(".map-marker");
    expect(marker?.classList.contains("map-marker--approximate")).toBe(true);
  });

  it("opens framed on the day's stops, without a camera move", () => {
    stubMedia();
    const points = dayPoints(0);
    render(<DayMapInner points={points} />);
    const map = lastMap();
    expect(map.options.bounds).toEqual(lngLatBounds(points));
    expect(map.options.fitBoundsOptions).toEqual({ padding: 40, maxZoom: 15 });
    expect(map.options.cooperativeGestures).toBe(true);
    expect(map.fitBounds).not.toHaveBeenCalled();
    expect(map.setStyle).not.toHaveBeenCalled();
  });

  it("glides to the next day's stops over 700 ms and redraws its route and markers", () => {
    stubMedia();
    const { container, rerender } = render(<DayMapInner points={dayPoints(0)} />);
    const next = dayPoints(1);
    rerender(<DayMapInner points={next} />);
    const map = lastMap();
    expect(map.fitBounds).toHaveBeenCalledWith(lngLatBounds(next), {
      padding: 40,
      maxZoom: 15,
      duration: 700,
      easing: easeOutExpo,
    });
    const style = map.setStyle.mock.calls.at(-1)?.[0];
    expect(style.sources.route).toEqual({ type: "geojson", data: routeData(next) });
    expect(markerNumbers(container)).toEqual(next.map((point) => String(point.number)));
  });

  it("jumps to the new stops without animation when the traveler prefers reduced motion", () => {
    stubMedia({ reduced: true });
    const { rerender } = render(<DayMapInner points={dayPoints(0)} />);
    const next = dayPoints(1);
    rerender(<DayMapInner points={next} />);
    const [bounds, options] = lastMap().fitBounds.mock.calls.at(-1) ?? [];
    expect(bounds).toEqual(lngLatBounds(next));
    expect(options).toEqual({ padding: 40, maxZoom: 15, animate: false });
  });

  it("follows the system colour scheme live, basemap and markers together", () => {
    const media = stubMedia({ dark: false });
    const { container } = render(<DayMapInner points={dayPoints(0)} />);
    const canvas = container.querySelector<HTMLElement>(".map-canvas");
    expect(canvas?.style.getPropertyValue("--map-ink")).toBe(PALETTES.light.ink);
    media.setDark(true);
    const style = lastMap().setStyle.mock.calls.at(-1)?.[0];
    expect(style.layers[0].paint).toEqual({ "background-color": PALETTES.dark.land });
    expect(canvas?.style.getPropertyValue("--map-ink")).toBe(PALETTES.dark.ink);
    expect(canvas?.style.getPropertyValue("--map-paper")).toBe(PALETTES.dark.paper);
  });

  it("swallows tile and glyph errors, and still logs any other error", () => {
    stubMedia();
    render(<DayMapInner points={dayPoints(0)} />);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const map = lastMap();
    map.emit("error", { sourceId: "basemap", error: new Error("Failed to fetch") });
    expect(log).not.toHaveBeenCalled();
    const bug = new Error("Invalid style");
    map.emit("error", { error: bug });
    expect(log).toHaveBeenCalledWith(bug);
  });

  it("shows the notice, and logs nothing, when MapLibre's worker cannot load", () => {
    stubMedia();
    render(<DayMapInner points={dayPoints(0)} />);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    // MapLibre's own message when the worker file fails to load (offline, or a dropped request).
    const failed = new Error("Worker failed to load. Check that the worker URL is correct.");
    act(() => lastMap().emit("error", { error: failed }));
    expect(screen.getByTestId("map-unavailable").textContent).toBe(MAP_UNAVAILABLE);
    expect(log).not.toHaveBeenCalled();
  });

  it("sets up the worker and the tile archive once, and rounds the basemap's tile zoom", () => {
    stubMedia();
    render(<DayMapInner points={dayPoints(0)} />);
    render(<DayMapInner points={dayPoints(1)} />);
    expect(fake.workerUrls).toEqual([
      `${window.location.origin}/map/maplibre/maplibre-gl-worker.mjs`,
    ]);
    expect(fake.protocols).toEqual(["pmtiles"]);
    lastMap().emit("styledata");
    expect(fake.basemap.roundZoom).toBe(true);
  });

  it("keeps its credits compact and folded, and nothing of its own in the tab order", () => {
    stubMedia();
    const { container, unmount } = render(<DayMapInner points={dayPoints(0)} />);
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
    unmount();
    expect(map.remove).toHaveBeenCalledOnce();
  });
});
