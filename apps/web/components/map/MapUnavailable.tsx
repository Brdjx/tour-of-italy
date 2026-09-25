import type { DayMapInnerProps } from "./types";

// The notice in the map's frame when the map cannot be drawn: its code did not load, the
// browser has no WebGL 2, or drawing threw. Its own file, so the map's lazily loaded code can
// show it without importing DayMap back.

export const MAP_UNAVAILABLE = "The map could not load. The list above has every stop in order.";

export function MapUnavailable(_props: Partial<DayMapInnerProps>) {
  return (
    <div className="map-placeholder px-4 text-center" data-testid="map-unavailable">
      {MAP_UNAVAILABLE}
    </div>
  );
}
