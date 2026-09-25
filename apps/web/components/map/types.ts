import type { MapPoint } from "../../lib/mapPoints";

// The props of the lazily loaded map (DayMapInner), in their own file so DayMap and the notice
// that stands in for the map can name them without importing the map's code.

/** A day in the full-screen map's day switcher. */
export interface MapDayOption {
  index: number;
  label: string; // "Day 1", on the switcher
  name: string; // "Day 1, Fri 9 Oct, Rome", its accessible name
}

export interface DayMapInnerProps {
  points: readonly MapPoint[];
  title: string; // "Day 1, Fri 9 Oct, Rome": the full-screen map's heading
  days: readonly MapDayOption[];
  active: number; // the day on the map, and on the page
  onSelectDay: (index: number) => void;
  onDetails: (placeId: string, opener: HTMLElement) => void; // opens the stop's details sheet
}
