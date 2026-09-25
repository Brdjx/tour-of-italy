"use client";

import { type PointerEvent, type RefObject, useRef } from "react";
import { gestureAxis, type Step, swipeOffset, swipeStep } from "./stopSteps";

// A sideways swipe on a stop's details steps to the previous or next stop. The first few px of
// movement decide the axis (lib/stopSteps.ts): down or up is the body's own scroll (the element
// takes `touch-action: pan-y pinch-zoom`, so the browser keeps it and the traveler's zoom),
// across follows the finger and steps when let go far or fast enough. Past the first or the last
// stop the content gives a little and comes back. Touch and pen only: a mouse drag across the
// text selects it. A second finger makes it a pinch, never a step: the swipe springs back.

interface SwipeOptions {
  can: { previous: boolean; next: boolean };
  onStep: (by: Step) => void;
  follow: RefObject<HTMLElement | null>; // what moves with the finger
  still: () => boolean; // reduced motion: nothing follows the finger, the step fades
}

interface Swipe {
  pointer: number;
  startX: number;
  startY: number;
  axis: "x" | "y" | null;
  dx: number;
  lastX: number;
  lastT: number;
  speed: number;
}

export interface SwipeHandlers {
  onPointerDown: (event: PointerEvent<HTMLElement>) => void;
  onPointerMove: (event: PointerEvent<HTMLElement>) => void;
  onPointerUp: (event: PointerEvent<HTMLElement>) => void;
  onPointerCancel: (event: PointerEvent<HTMLElement>) => void;
}

export function useSwipeSteps(options: SwipeOptions): SwipeHandlers {
  const swipe = useRef<Swipe | null>(null);
  const latest = useRef(options);
  latest.current = options;

  /** Puts the content back: at once after a step (the new stop slides in), else on its spring. */
  const settle = (stepped: boolean) => {
    swipe.current = null;
    const element = latest.current.follow.current;
    if (!element) return;
    element.style.transform = "";
    if (stepped) void element.offsetWidth; // the jump back lands before the transition returns
    delete element.dataset.swiping;
  };

  return {
    onPointerDown: (event) => {
      if (!event.isPrimary) {
        if (swipe.current) settle(false);
        return;
      }
      if (event.pointerType === "mouse") return;
      swipe.current = {
        pointer: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        axis: null,
        dx: 0,
        lastX: event.clientX,
        lastT: event.timeStamp,
        speed: 0,
      };
    },
    onPointerMove: (event) => {
      const current = swipe.current;
      if (!current || current.pointer !== event.pointerId) return;
      current.dx = event.clientX - current.startX;
      current.axis ??= gestureAxis(current.dx, event.clientY - current.startY);
      if (current.axis === null) return;
      if (current.axis === "y") {
        swipe.current = null; // the body scrolls; this gesture is not a step
        return;
      }
      const elapsed = Math.max(1, event.timeStamp - current.lastT);
      current.speed = (event.clientX - current.lastX) / elapsed;
      current.lastX = event.clientX;
      current.lastT = event.timeStamp;
      const { follow, can, still } = latest.current;
      const element = follow.current;
      if (!element || still()) return;
      element.dataset.swiping = "true";
      element.style.transform = `translateX(${swipeOffset(current.dx, can)}px)`;
    },
    onPointerUp: (event) => {
      const current = swipe.current;
      if (!current || current.pointer !== event.pointerId) return;
      const { can, onStep } = latest.current;
      const by = current.axis === "x" ? swipeStep(current.dx, current.speed) : 0;
      const allowed = by === 1 ? can.next : by === -1 ? can.previous : false;
      settle(allowed);
      if (allowed && by !== 0) onStep(by);
    },
    onPointerCancel: (event) => {
      if (swipe.current?.pointer === event.pointerId) settle(false);
    },
  };
}
