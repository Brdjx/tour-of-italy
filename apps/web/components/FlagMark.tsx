"use client";

import { useEffect, useId, useRef } from "react";
import {
  bandPath,
  clothPath,
  edgePath,
  FLAG_HEIGHT,
  FLAG_WIDTH,
  restShape,
  SHADE_OFFSETS,
  shadeValues,
  WAVE_KEY_TIMES,
  WAVE_MS,
  type WaveFrame,
  waveValues,
} from "../lib/flagWave";

// The flag mark that leads the first screen's title, at the title's cap height, like a lockup.
// Its three bands draw in from the top, green then white then red (CSS, tricolore.css), in the
// page's sweep from the top left; then one breath of wind passes through it, a fold of light and
// shade travelling with the ripple, and it rests flat (SMIL, lib/flagWave.ts). A mouse resting on
// it keeps it waving until the mouse leaves. Its colours are
// the Tricolore Rule's tokens; the light and shade are paper and ink laid over them, at nothing
// when the flag is flat.
//
// Decision: hidden from assistive technology. The heading it leads already says "Italy", so a
// "Flag of Italy" before it would be noise; the mark adds no fact.
//
// Decision: the wave is SMIL, begun from here only when the traveler allows motion. SMIL runs in
// Safari, Chrome and Firefox, while CSS cannot animate a path's shape in Safari. SMIL does not
// read prefers-reduced-motion, so it waits for this effect (begin="indefinite"). Its first and
// last frames are the flat flag with no light or shade, which is also what shows without it.

type Shape = (frame: WaveFrame) => string;

const green: Shape = (frame) => bandPath(0, frame);
const white: Shape = (frame) => bandPath(1, frame);
const red: Shape = (frame) => bandPath(2, frame);
const topEdge: Shape = (frame) => edgePath("top", frame);
const bottomEdge: Shape = (frame) => edgePath("bottom", frame);

const MOTION_OK = "(prefers-reduced-motion: no-preference)";

type SmilAnimation = SVGElement & { beginElement?: () => void };

function motionAllowed(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(MOTION_OK).matches;
}

/** One attribute through the whole wave, begun with the rest by the effect below. Decision:
 * straight steps between frames (calcMode linear). The frames are the breath sampled evenly, so
 * the easing is in them already, and an ease on every step would stop the cloth at each one. */
function Wave({ attribute, values }: { attribute: string; values: string }) {
  return (
    <animate
      className="flag-mark-wave"
      attributeName={attribute}
      dur={`${WAVE_MS}ms`}
      begin="indefinite"
      fill="freeze"
      calcMode="linear"
      keyTimes={WAVE_KEY_TIMES.join(";")}
      values={values}
    />
  );
}

/** A path at rest, with the animation that carries it through the wave. */
function Cloth({ shape, className, fill }: { shape: Shape; className: string; fill?: string }) {
  return (
    <path className={className} d={restShape(shape)} fill={fill}>
      <Wave attribute="d" values={waveValues(shape)} />
    </path>
  );
}

/** Paper (light) or ink (shade) across the cloth, as strong as its slope at each sample. */
function Fold({ id, kind }: { id: string; kind: "light" | "shade" }) {
  return (
    <linearGradient id={id} x1="0" x2="1" y1="0" y2="0">
      {SHADE_OFFSETS.map((share) => (
        <stop key={share} offset={share} className={`flag-mark-${kind}`} stopOpacity={0}>
          <Wave attribute="stop-opacity" values={shadeValues(kind, share)} />
        </stop>
      ))}
    </linearGradient>
  );
}

export function FlagMark() {
  const ref = useRef<SVGSVGElement>(null);
  const id = useId();
  const lightId = `${id}-light`;
  const shadeId = `${id}-shade`;

  useEffect(() => {
    const svg = ref.current;
    if (!svg) return;
    if (!motionAllowed()) {
      svg.dataset.state = "rest";
      return;
    }
    let live = true;
    let drawn = false;
    let hovering = false;
    let waving = false;
    const waves = [...svg.querySelectorAll<SmilAnimation>(".flag-mark-wave")];
    const first = waves[0];
    const rest = () => {
      waving = false;
      svg.dataset.state = "rest";
    };
    const wave = () => {
      if (!live) return;
      // Checked again here: the bands' drop-in can end early (cancelled), and this runs then too.
      if (!motionAllowed()) return rest();
      // No SMIL here (the unit tests' DOM): the flag stays at rest, flat.
      if (typeof first?.beginElement !== "function") return rest();
      waving = true;
      svg.dataset.state = "waving";
      for (const animation of waves) animation.beginElement?.();
    };
    // Decision: while a mouse rests on the flag, each breath's end begins the next, so it keeps
    // waving; when the mouse leaves, the breath under way finishes and the flag settles flat,
    // never stopping mid-ripple. Every breath starts and ends flat, so the joins do not jump.
    // Touch is left out: a finger never leaves, and a tap would set it waving for good.
    const ended = () => (live && hovering ? wave() : rest());
    const enter = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      hovering = true;
      if (drawn && !waving) wave();
    };
    const leave = () => {
      hovering = false;
    };
    first?.addEventListener("endEvent", ended);
    svg.addEventListener("pointerenter", enter);
    svg.addEventListener("pointerleave", leave);
    // The wind comes once the bands have drawn in, when their CSS animations finish.
    const begin = () => {
      drawn = true;
      wave();
    };
    const drawing =
      typeof svg.getAnimations === "function" ? svg.getAnimations({ subtree: true }) : [];
    Promise.all(drawing.map((animation) => animation.finished)).then(begin, begin);
    return () => {
      live = false;
      first?.removeEventListener("endEvent", ended);
      svg.removeEventListener("pointerenter", enter);
      svg.removeEventListener("pointerleave", leave);
    };
  }, []);

  return (
    <svg
      ref={ref}
      className="flag-mark"
      viewBox={`0 0 ${FLAG_WIDTH} ${FLAG_HEIGHT}`}
      aria-hidden="true"
      focusable="false"
      data-testid="flag-mark"
      data-state="drawing"
    >
      {/* The white band first, so the green and red are drawn over its seams. */}
      <g className="flag-mark-band flag-mark-band--white">
        <Cloth shape={white} className="flag-mark-white" />
        <Cloth shape={topEdge} className="flag-mark-edge" />
        <Cloth shape={bottomEdge} className="flag-mark-edge" />
      </g>
      <Cloth shape={green} className="flag-mark-band flag-mark-band--green" />
      <Cloth shape={red} className="flag-mark-band flag-mark-band--red" />
      {/* The light and shade, over all three bands: nothing until the wind comes. */}
      <defs>
        <Fold id={lightId} kind="light" />
        <Fold id={shadeId} kind="shade" />
      </defs>
      <Cloth shape={clothPath} className="flag-mark-fold" fill={`url(#${lightId})`} />
      <Cloth shape={clothPath} className="flag-mark-fold" fill={`url(#${shadeId})`} />
    </svg>
  );
}
