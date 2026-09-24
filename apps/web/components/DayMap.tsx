"use client";

import type { DayPlan, PlannerContext } from "@italy/planner";
import dynamic from "next/dynamic";
import { Component, type ReactNode, useMemo } from "react";
import { type MapPoint, mapPoints } from "../lib/mapPoints";

// The day's map, below the timetable. Leaflet needs `window`, so it is loaded only in the
// browser; the static export ships a placeholder in its place. The map is optional: if its code
// cannot be fetched (a dropped request, offline before the worker cached it) or Leaflet throws,
// the frame says so and the rest of the page carries on. The map is hidden from screen readers
// because the timetable above lists the same stops in the same order.

export const MAP_UNAVAILABLE = "The map could not load. The list above has every stop in order.";

type MapModule = { default: (props: { points: readonly MapPoint[] }) => ReactNode };

const loadInner = () => import("./DayMapInner");

export function MapUnavailable(_props: { points?: readonly MapPoint[] }) {
  return (
    <div className="map-placeholder px-4 text-center" data-testid="map-unavailable">
      {MAP_UNAVAILABLE}
    </div>
  );
}

/**
 * The map component, or the notice when its code cannot be loaded.
 * Decision: a failed chunk load resolves to the notice instead of rejecting. A rejected dynamic
 * import is thrown during render, and without this the whole page was replaced by Next's
 * generic error screen, plan and all.
 */
export function withMapFallback(load: () => Promise<MapModule>): Promise<MapModule> {
  return load().catch(() => ({ default: MapUnavailable }));
}

const DayMapInner = dynamic(() => withMapFallback(loadInner), {
  ssr: false,
  loading: () => <div className="map-placeholder">Loading map</div>,
});

/** Catches anything Leaflet throws while drawing, so a map problem stays inside the frame. */
export class MapBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override render() {
    return this.state.failed ? <MapUnavailable /> : this.props.children;
  }
}

/**
 * Fetches the map's code when the browser is idle, so it is in the HTTP cache (and the
 * worker's) before the first plan needs it. Returns a function that cancels a pending fetch.
 */
export function prefetchMap(): () => void {
  const run = () => {
    loadInner().catch(() => {
      // The map will show its notice when it is needed; nothing to do now.
    });
  };
  if (typeof window.requestIdleCallback === "function") {
    const id = window.requestIdleCallback(run, { timeout: 5000 });
    return () => window.cancelIdleCallback(id);
  }
  const timer = window.setTimeout(run, 2000);
  return () => window.clearTimeout(timer);
}

interface DayMapProps {
  day: DayPlan;
  dayNumber: number;
  ctx: PlannerContext;
}

export function DayMap({ day, dayNumber, ctx }: DayMapProps) {
  const points = useMemo(() => mapPoints(day, ctx), [day, ctx]);
  const approximate = points.some((point) => point.approximate);
  return (
    <figure className="mt-6" data-testid="day-map">
      <p className="sr-only">
        Map of day {dayNumber}. It shows the stops listed above, numbered in visiting order.
      </p>
      <div className="map-frame" aria-hidden="true">
        <MapBoundary>
          <DayMapInner points={points} />
        </MapBoundary>
      </div>
      <figcaption className="mt-2 text-sm text-muted">
        <span className="block">
          Stops are numbered in visiting order.
          {approximate ? " An open circle marks an approximate location." : null}
        </span>
        <span className="block">
          Map data ©{" "}
          <a
            href="https://www.openstreetmap.org/copyright"
            className="inline-flex min-h-11 items-center text-accent underline underline-offset-2"
            target="_blank"
            rel="noreferrer"
          >
            OpenStreetMap contributors
          </a>
        </span>
      </figcaption>
    </figure>
  );
}
