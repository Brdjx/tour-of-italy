import { type Box, flipFrames } from "../../lib/mapGeometry";

// The full-screen map's motion, on the Web Animations API: transform on the frame and the map
// inside it (the map is never stretched, see flipFrames), or a fade under reduced motion. The
// browser runs these on the compositor, so they stay smooth while MapLibre draws. Where the API
// is missing (jsdom in the unit tests) nothing animates and the change is immediate.

/** The page's own spring (--spring-smooth in globals.css), or its ease-out if it cannot be read. */
const EASE_OUT = "cubic-bezier(0.16, 1, 0.3, 1)";

export function smoothSpring(): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue("--spring-smooth");
  return value.trim() || EASE_OUT;
}

function play(
  element: Element,
  keyframes: Keyframe[],
  options: KeyframeAnimationOptions,
): Animation | null {
  if (typeof element.animate !== "function") return null;
  try {
    return element.animate(keyframes, options);
  } catch {
    // A browser that cannot read linear() easing throws; the ease-out is close enough.
    return element.animate(keyframes, { ...options, easing: EASE_OUT });
  }
}

/**
 * Grows the frame from `from` to `to` (open: the page's box to full screen; close: the other way),
 * keeping the map inside it at its real size. Resolves when both have finished or were cancelled.
 */
export function flip(
  frame: HTMLElement,
  inner: HTMLElement,
  from: Box,
  to: Box,
  direction: "grow" | "shrink",
  duration: number,
): Animation[] {
  // The frames always run from the smaller box (0) to the larger one (1).
  const frames = direction === "grow" ? flipFrames(from, to) : flipFrames(to, from);
  const order = <T>(list: T[]): T[] => (direction === "grow" ? list : [...list].reverse());
  const options: KeyframeAnimationOptions = {
    duration,
    easing: smoothSpring(),
    fill: direction === "shrink" ? "forwards" : "none",
  };
  const animations = [
    play(
      frame,
      order(frames.frame).map((transform) => ({ transform })),
      options,
    ),
    play(
      inner,
      order(frames.inner).map((transform) => ({ transform })),
      options,
    ),
  ];
  return animations.filter((animation): animation is Animation => animation !== null);
}

/** The reduced-motion stand-in: the dialog fades in or out, and nothing moves. */
export function fade(element: HTMLElement, show: boolean, duration: number): Animation[] {
  const keyframes = show ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 1 }, { opacity: 0 }];
  const animation = play(element, keyframes, {
    duration,
    easing: "ease",
    fill: show ? "none" : "forwards",
  });
  return animation ? [animation] : [];
}

/** Resolves once every animation has finished or been cancelled. */
export function settled(animations: readonly Animation[]): Promise<void> {
  return Promise.all(animations.map((animation) => animation.finished.catch(() => undefined))).then(
    () => undefined,
  );
}
