// The five bases as a line diagram, drawn once when the page opens: Milan at the top left,
// through Bologna and Florence, down to Rome at the bottom right, with Venice joining at
// Bologna. Every trip is planned from these bases (packages/planner/src/anchors.ts), and the
// planner's travel model joins them by intercity rail, so the drawing states a fact about the
// product. The drawing is schematic (45 degree bends), not a map.

interface Station {
  name: string;
  x: number;
  y: number;
  label: { x: number; y: number; anchor: "start" | "end" }; // placed clear of the line
  delay: number; // ms after the line starts, when the line reaches the station
}

/** When the line starts drawing (compose.css waits the same 120 ms). */
const LINE_START_MS = 120;

// Decision: stations sit where the drawn line passes them, so each one appears as the line
// arrives rather than all at once.
const STATIONS: readonly Station[] = [
  { name: "Milan", x: 24, y: 24, label: { x: 16, y: 48, anchor: "start" }, delay: 0 },
  { name: "Venice", x: 404, y: 24, label: { x: 412, y: 48, anchor: "end" }, delay: 520 },
  { name: "Bologna", x: 250, y: 64, label: { x: 234, y: 69, anchor: "end" }, delay: 380 },
  { name: "Florence", x: 250, y: 100, label: { x: 264, y: 105, anchor: "start" }, delay: 520 },
  { name: "Rome", x: 322, y: 136, label: { x: 336, y: 141, anchor: "start" }, delay: 760 },
];

// Milan east, a 45 degree bend down to Bologna, south to Florence, a bend down to Rome.
const MAIN = "M24 24 H210 L250 64 V100 L286 136 H322";
// Venice west, then a 45 degree bend down to Bologna, drawn from Bologna outward.
const BRANCH = "M250 64 L290 24 H404";

export function BaseLine() {
  return (
    <svg
      className="base-line"
      viewBox="0 0 440 152"
      role="img"
      aria-labelledby="base-line-title"
      data-testid="base-line"
    >
      <title id="base-line-title">
        Trips are planned from five bases: Milan, Venice, Bologna, Florence and Rome.
      </title>
      <path className="base-line-track base-line-track--main" d={MAIN} pathLength={1} />
      <path className="base-line-track base-line-track--branch" d={BRANCH} pathLength={1} />
      {STATIONS.map((station) => (
        <g
          key={station.name}
          className="base-line-station"
          style={{ animationDelay: `${LINE_START_MS + station.delay}ms` }}
        >
          <circle
            className="base-line-dot"
            cx={station.x}
            cy={station.y}
            r={5.5}
            style={{ transformOrigin: `${station.x}px ${station.y}px` }}
          />
          <text
            className="base-line-label"
            x={station.label.x}
            y={station.label.y}
            textAnchor={station.label.anchor}
          >
            {station.name}
          </text>
        </g>
      ))}
    </svg>
  );
}
