"use client";

import type { PlannerContext } from "@italy/planner";
import dynamic from "next/dynamic";
import { Component, type ComponentType, type ReactNode, useMemo } from "react";
import { mapDayTitle, mapPoints } from "../lib/mapPoints";
import type { DayView } from "../lib/timetable";
import { MapUnavailable } from "./map/MapUnavailable";
import type { DayMapInnerProps, MapDayOption } from "./map/types";
import { Skeleton } from "./skeleton/Skeleton";

// The day's map, below the timetable (beside it from 1024 px). MapLibre needs `window` and
// WebGL, so it is loaded only in the browser, in its own chunk; until its code arrives a
// skeleton fills the frame, which keeps the map's size, so nothing moves when the map draws.
// The map is optional: if its code cannot be fetched (a dropped request, offline before the
// worker cached it), the browser has no WebGL 2, or MapLibre throws, the frame says so and the
// rest of the page carries on. Its stops are buttons named like the board's rows ("Stop 2,
// Borghese Gallery, 10:50 to 12:50, lunch") that open the same details sheet; the drawing
// itself is hidden from screen readers, since the timetable above lists the same stops.
// "Expand map" opens the day's map full screen (DayMapInner).

export { MAP_UNAVAILABLE, MapUnavailable } from "./map/MapUnavailable";

type MapModule = { default: ComponentType<DayMapInnerProps> };

const loadInner = () => import("./DayMapInner");

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
  loading: () => <Skeleton className="skeleton--fill" testId="map-skeleton" />,
});

/** Catches anything MapLibre throws while drawing, so a map problem stays inside the frame. */
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
  days: readonly DayView[];
  active: number; // the index of the day shown
  ctx: PlannerContext;
  onSelectDay: (index: number) => void;
  onDetails: (placeId: string, opener: HTMLElement) => void;
}

export function DayMap({ days, active, ctx, onSelectDay, onDetails }: DayMapProps) {
  const view = days[active] ?? days[0];
  const day = view?.day;
  const points = useMemo(() => (day ? mapPoints(day, ctx) : []), [day, ctx]);
  const options = useMemo(
    () =>
      days.map(
        (item): MapDayOption => ({
          index: item.index,
          label: `Day ${item.index + 1}`,
          name: mapDayTitle(item),
        }),
      ),
    [days],
  );
  const approximate = points.some((point) => point.approximate);
  const dayNumber = (view?.index ?? 0) + 1;
  return (
    <figure className="day-map" data-testid="day-map">
      <p className="sr-only">
        Map of day {dayNumber}. It shows the stops listed above, numbered in visiting order.
      </p>
      <div className="map-frame">
        <MapBoundary>
          <DayMapInner
            points={points}
            title={view ? mapDayTitle(view) : ""}
            days={options}
            active={view?.index ?? 0}
            onSelectDay={onSelectDay}
            onDetails={onDetails}
          />
        </MapBoundary>
      </div>
      <figcaption className="mt-2 text-sm text-muted">
        <span className="block">
          Stops are numbered in visiting order.
          {approximate ? " A dashed circle marks an approximate location." : null}
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
          {" · "}
          <a
            href="https://protomaps.com"
            className="inline-flex min-h-11 items-center text-accent underline underline-offset-2"
            target="_blank"
            rel="noreferrer"
          >
            Protomaps
          </a>
        </span>
      </figcaption>
    </figure>
  );
}
