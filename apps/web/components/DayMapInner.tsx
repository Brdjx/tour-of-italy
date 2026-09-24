"use client";

import "leaflet/dist/leaflet.css";
import L from "leaflet";
import { useEffect, useMemo } from "react";
import { MapContainer, Marker, Polyline, TileLayer, useMap } from "react-leaflet";
import { boundsOf, type MapPoint, markerHtml } from "../lib/mapPoints";

// The Leaflet map itself, loaded only in the browser (see DayMap). OpenStreetMap tiles, one
// numbered marker per stop in visiting order, a route line in Lagoon, and hollow markers for
// approximate locations. It has no keyboard stops of its own: the timetable is its text
// equivalent, so the map stays a visual aid.

const TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const ITALY_CENTER: [number, number] = [42.5, 12.5];

function FitToPoints({ points }: { points: readonly MapPoint[] }) {
  const map = useMap();
  const key = points.map((point) => `${point.placeId}@${point.lat},${point.lng}`).join("|");
  useEffect(() => {
    // `key` is read so the view refits whenever the stops change.
    void key;
    const bounds = boundsOf(points);
    if (!bounds) return;
    map.fitBounds(bounds, { padding: [36, 36], maxZoom: 15, animate: false });
  }, [map, key, points]);
  return null;
}

export default function DayMapInner({ points }: { points: readonly MapPoint[] }) {
  const icons = useMemo(
    () =>
      points.map((point) =>
        L.divIcon({
          html: markerHtml(point),
          className: "map-marker-wrap",
          iconSize: [30, 30],
          iconAnchor: [15, 15],
        }),
      ),
    [points],
  );
  const line = points.map((point) => [point.lat, point.lng] as [number, number]);
  return (
    <MapContainer
      center={ITALY_CENTER}
      zoom={6}
      className="h-full w-full"
      scrollWheelZoom={false}
      keyboard={false}
      zoomControl={false}
      attributionControl={false}
      // Decision: no one-finger panning on touch screens, so a finger on the map still scrolls
      // the page. Pinch zoom still works.
      dragging={!L.Browser.mobile}
    >
      <TileLayer url={TILE_URL} />
      {line.length > 1 ? (
        // Decision: className as a top-level prop. react-leaflet passes top-level props to the
        // L.Polyline constructor, which sets the class; pathOptions go through setStyle(), which
        // ignores className, and left the line in Leaflet's default blue.
        <Polyline positions={line} interactive={false} className="route-line" />
      ) : null}
      {points.map((point, index) => (
        <Marker
          key={point.placeId}
          position={[point.lat, point.lng]}
          icon={icons[index] as L.DivIcon}
          interactive={false}
          keyboard={false}
        />
      ))}
      <FitToPoints points={points} />
    </MapContainer>
  );
}
