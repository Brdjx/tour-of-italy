import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DayMap,
  MAP_UNAVAILABLE,
  MapBoundary,
  MapUnavailable,
  prefetchMap,
  withMapFallback,
} from "../components/DayMap";
import DayMapInner from "../components/DayMapInner";
import { mapPoints } from "../lib/mapPoints";
import { ctx, fixturePlan, must } from "./fixtures";

// The map is optional. A failed chunk load or a Leaflet error must stay inside the map frame;
// before this, one dropped request replaced the whole page, plan and all, with Next's error
// screen.

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
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
      throw new Error("Leaflet could not draw");
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
    vi.unstubAllGlobals();
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
});

describe("DayMapInner", () => {
  it("draws the route with the route-line class, so it takes the Lagoon token, not Leaflet blue", () => {
    const plan = fixturePlan();
    const points = mapPoints(must(plan.days[0]), ctx);
    const { container } = render(
      <div style={{ width: 400, height: 300 }}>
        <DayMapInner points={points} />
      </div>,
    );
    const path = container.querySelector("path.route-line");
    expect(path).not.toBeNull();
  });
});
