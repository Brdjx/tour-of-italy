// Runs a layout-changing callback only after the press that caused it has finished.
//
// Why: Chromium moves focus on mousedown. When a blur handler collapses content right away, the
// button the traveler pressed moves up before mouseup, and the click lands on nothing (a chip
// explanation closing under a Swap button lost the first press on desktop and Android). Waiting
// for pointerup, then one more task, lets the click reach its target first. A touch tap sends
// mousedown, mouseup and click together after the finger lifts, so one task is enough there.

let pointerDown = false;
let installed = false;

/** Starts tracking whether a pointer is pressed. Safe to call many times. */
export function trackPointer(target: Pick<Window, "addEventListener"> = window): void {
  if (installed) return;
  installed = true;
  const up = () => {
    pointerDown = false;
  };
  target.addEventListener(
    "pointerdown",
    () => {
      pointerDown = true;
    },
    true,
  );
  target.addEventListener("pointerup", up, true);
  target.addEventListener("pointercancel", up, true);
}

/** Calls `callback` once the current pointer press (if any) has produced its click. */
export function afterPress(callback: () => void, target: Window = window): void {
  if (!pointerDown) {
    setTimeout(callback, 0);
    return;
  }
  const done = () => {
    target.removeEventListener("pointerup", done, true);
    target.removeEventListener("pointercancel", done, true);
    setTimeout(callback, 0);
  };
  target.addEventListener("pointerup", done, true);
  target.addEventListener("pointercancel", done, true);
}

/** Test helper: forget the tracked state between tests. */
export function resetPointerTracking(): void {
  pointerDown = false;
}
