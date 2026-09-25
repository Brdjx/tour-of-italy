import { formatClock } from "./format";
import { type RowView, stopName } from "./timetable";

// Stepping through a day's stops in the details sheet (StopDetailsSheet): what the sheet says when
// it steps, which keys step, and how a finger's movement becomes a step. Kept out of the
// components so the rules are unit tested without a browser.

/** A gesture's direction is decided once it has moved this far from where it began, in px. */
export const AXIS_SLOP = 10;
/** A swipe let go past this distance steps, in px. */
export const SWIPE_DISTANCE = 64;
/** A shorter swipe still steps when let go this fast (px per ms), past SWIPE_FLICK_MIN. */
export const SWIPE_FLICK_SPEED = 0.35;
export const SWIPE_FLICK_MIN = 24;
/** Past the first or the last stop the content follows the finger this much, then comes back. */
export const SWIPE_RESIST = 0.25;

export type Axis = "x" | "y";
export type Step = -1 | 1;

/**
 * The axis a gesture moves along, decided by its first AXIS_SLOP px, or null while it is still
 * inside them. A move as far down as across is vertical: scrolling and closing the sheet are
 * what a finger usually means, and a step it did not mean loses the traveler's place.
 */
export function gestureAxis(dx: number, dy: number, slop = AXIS_SLOP): Axis | null {
  if (Math.hypot(dx, dy) < slop) return null;
  return Math.abs(dx) > Math.abs(dy) ? "x" : "y";
}

/**
 * The step a sideways swipe asks for when the finger lets go: 1 for the next stop (a swipe to
 * the left, as a page turns), -1 for the previous, 0 for none. `speed` is the finger's last
 * speed along x in px per ms; a flick back against the swipe cancels it.
 */
export function swipeStep(dx: number, speed: number): Step | 0 {
  const far = Math.abs(dx) >= SWIPE_DISTANCE;
  const flick =
    Math.abs(dx) >= SWIPE_FLICK_MIN &&
    Math.abs(speed) >= SWIPE_FLICK_SPEED &&
    Math.sign(speed) === Math.sign(dx);
  const back = Math.abs(speed) >= SWIPE_FLICK_SPEED && Math.sign(speed) === -Math.sign(dx);
  if ((!far && !flick) || back) return 0;
  return dx < 0 ? 1 : -1;
}

/**
 * How far the content follows a finger that has moved `dx` px across: all the way toward a
 * stop that exists, a quarter of the way past the first or the last.
 */
export function swipeOffset(dx: number, can: { previous: boolean; next: boolean }): number {
  const toward = dx < 0 ? can.next : can.previous;
  return toward ? dx : dx * SWIPE_RESIST;
}

/** The step an arrow key asks for, or null for any other key or an arrow held with a modifier. */
export function keyStep(event: {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): Step | null {
  // Decision: a modifier leaves the key to the browser and the system (Alt+Left is Back,
  // Cmd+Left the start of the line), so only the bare arrows step.
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null;
  if (event.key === "ArrowRight") return 1;
  if (event.key === "ArrowLeft") return -1;
  return null;
}

/** Inputs whose arrows move a caret, a value or a choice. */
const ARROW_INPUTS = new Set([
  "text",
  "search",
  "email",
  "url",
  "tel",
  "password",
  "number",
  "date",
  "datetime-local",
  "month",
  "time",
  "week",
  "range",
  "radio",
]);

/** Widgets whose own keyboard pattern uses the arrows (the ARIA practices). */
const ARROW_WIDGETS = [
  "slider",
  "radiogroup",
  "tablist",
  "listbox",
  "grid",
  "treegrid",
  "tree",
  "menu",
  "menubar",
  "combobox",
  "spinbutton",
].map((role) => `[role="${role}"]`);

/**
 * Whether the arrows belong to this element: a field that takes text, a slider or a radio, a
 * select, editable text, or a widget that moves with them (a tab list, a menu, a list box).
 */
export function takesArrows(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement && ARROW_INPUTS.has(target.type)) return true;
  return target.closest(ARROW_WIDGETS.join(",")) !== null;
}

/** "Stop 4 of 6, Spanish Steps, 16:30 to 16:50", as the sheet says it when it steps. */
export function stepAnnouncement(row: RowView, count: number): string {
  const times = `${formatClock(row.stop.start)} to ${formatClock(row.stop.end)}`;
  const parts = [`Stop ${row.index + 1} of ${count}`, stopName(row), times];
  // A meal says which, as the map's stops do ("..., lunch").
  if (row.stop.role !== "visit") parts.push(row.stop.role);
  return parts.join(", ");
}
