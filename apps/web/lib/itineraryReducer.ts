import {
  type Itinerary,
  moveStop,
  type PlannerContext,
  removeStop,
  replaceStop,
  rescheduleDay,
  type Violation,
  validationErrors,
} from "@italy/planner";
import type { FallbackCause } from "./planRequest";

// Plan state and every edit the traveler can make: a new plan, swap, remove, move up or down,
// and undo. Each edit rebuilds only the affected day with the planner's rescheduleDay (which
// retimes it with scheduleDay and refreshes the warnings), then runs the independent validator
// over the whole trip. An edit that breaks a rule is kept and flagged, never hidden, and undo
// is always one tap away.

export type PlanOrigin = "api" | "offline" | "shared";
export type EditKind = "swap" | "remove" | "move";

export interface HistoryEntry {
  itinerary: Itinerary;
  errors: Violation[];
  kind: EditKind;
  at: { day: number; stop: number }; // the row the edit touched, where undo puts it back
}

export interface ItineraryState {
  itinerary: Itinerary | null;
  origin: PlanOrigin;
  cause: FallbackCause | null; // why the browser built it, when it did
  errors: Violation[]; // error-level violations of the current plan; empty for a clean plan
  checked: boolean; // `errors` came from this browser's validator (false until places load)
  history: HistoryEntry[]; // most recent last, at most HISTORY_LIMIT
  planId: number; // increases with every new plan (drives the one draw-in animation)
  changed: { day: number; stop: number } | null; // the row the last edit touched
  message: string | null; // one status sentence for the live region
}

export type ItineraryAction =
  | {
      type: "plan";
      itinerary: Itinerary;
      origin: PlanOrigin;
      cause?: FallbackCause | null;
      message?: string;
    }
  | { type: "swap"; day: number; stop: number; placeId: string }
  | { type: "remove"; day: number; stop: number }
  | { type: "move"; day: number; stop: number; direction: "up" | "down" }
  | { type: "undo" }
  | { type: "check" }
  | { type: "clear" };

/** Undo steps kept. Small on purpose: each entry holds a whole itinerary. */
export const HISTORY_LIMIT = 10;

export const UNDO_LABELS: Record<EditKind, string> = {
  swap: "Undo swap",
  remove: "Undo remove",
  move: "Undo move",
};

export function initialItineraryState(): ItineraryState {
  return {
    itinerary: null,
    origin: "api",
    cause: null,
    errors: [],
    checked: false,
    history: [],
    planId: 0,
    changed: null,
    message: null,
  };
}

/** Pure reducer. `ctx` is the loaded places; edits without it are refused with a message. */
export function itineraryReducer(
  state: ItineraryState,
  action: ItineraryAction,
  ctx: PlannerContext | null,
): ItineraryState {
  switch (action.type) {
    case "plan":
      return {
        itinerary: action.itinerary,
        origin: action.origin,
        cause: action.cause ?? null,
        errors: ctx ? validationErrors(action.itinerary, ctx) : [],
        checked: ctx !== null,
        history: [],
        planId: state.planId + 1,
        changed: null,
        message: action.message ?? "Your plan is ready.",
      };
    case "undo":
      return undo(state);
    case "check":
      return check(state, ctx);
    case "clear":
      return { ...initialItineraryState(), planId: state.planId };
    default:
      return edit(state, action, ctx);
  }
}

type EditAction = Extract<ItineraryAction, { type: "swap" | "remove" | "move" }>;

function edit(state: ItineraryState, action: EditAction, ctx: PlannerContext | null) {
  const itinerary = state.itinerary;
  const day = itinerary?.days[action.day];
  const stop = day?.stops[action.stop];
  if (!itinerary || !day || !stop) return { ...state, message: "That stop is no longer here." };
  if (!ctx) return { ...state, message: "Places are still loading. Try again in a moment." };
  const name = ctx.placesById.get(stop.placeId)?.name ?? "This stop";
  if (action.type === "remove") {
    if (day.stops.length === 1) {
      return { ...state, message: "A day needs at least one stop. Swap this one instead." };
    }
    return apply(state, ctx, action.day, removeStop(day, action.stop), {
      kind: "remove",
      at: { day: action.day, stop: action.stop },
      changed: null,
      text: `Removed ${name}.`,
    });
  }
  if (action.type === "move") {
    const to = action.direction === "up" ? action.stop - 1 : action.stop + 1;
    if (to < 0 || to >= day.stops.length) return state;
    return apply(state, ctx, action.day, moveStop(day, action.stop, to), {
      kind: "move",
      at: { day: action.day, stop: action.stop },
      changed: { day: action.day, stop: to },
      text: `Moved ${name} ${action.direction}.`,
    });
  }
  const next = ctx.placesById.get(action.placeId);
  if (!next || next.id === stop.placeId) return { ...state, message: "That place cannot be used." };
  return apply(state, ctx, action.day, replaceStop(day, action.stop, next.id), {
    kind: "swap",
    at: { day: action.day, stop: action.stop },
    changed: { day: action.day, stop: action.stop },
    text: `Swapped ${name} for ${next.name}.`,
  });
}

interface EditResult {
  kind: EditKind;
  at: HistoryEntry["at"];
  changed: ItineraryState["changed"];
  text: string;
}

function apply(
  state: ItineraryState,
  ctx: PlannerContext,
  dayIndex: number,
  orderedIds: string[],
  result: EditResult,
): ItineraryState {
  const current = state.itinerary as Itinerary;
  const rebuilt = rescheduleDay(current, dayIndex, orderedIds, ctx).itinerary;
  // Decision: the validator, not the scheduler, decides what is flagged. It is independent of
  // the code that just retimed the day, so a scheduler bug still shows up as a flagged row.
  const errors = validationErrors(rebuilt, ctx);
  const entry: HistoryEntry = {
    itinerary: current,
    errors: state.errors,
    kind: result.kind,
    at: result.at,
  };
  const history = [...state.history, entry].slice(-HISTORY_LIMIT);
  const problem =
    errors.length === 0
      ? " Times updated."
      : ` This breaks ${errors.length === 1 ? "a rule" : `${errors.length} rules`}; see the flagged stops, or undo.`;
  return {
    ...state,
    itinerary: rebuilt,
    errors,
    history,
    changed: result.changed,
    message: `${result.text}${problem}`,
  };
}

/**
 * Validates a plan that arrived before the places did (planning works from the first paint).
 * Decision: it flags what breaks a rule instead of replacing the plan, and says nothing new:
 * "Your plan is ready" was already announced when the plan arrived.
 */
function check(state: ItineraryState, ctx: PlannerContext | null): ItineraryState {
  if (!ctx || !state.itinerary || state.checked) return state;
  const errors = validationErrors(state.itinerary, ctx);
  return { ...state, errors, checked: true, message: null };
}

function undo(state: ItineraryState): ItineraryState {
  const last = state.history.at(-1);
  if (!last) return { ...state, message: "Nothing to undo." };
  return {
    ...state,
    itinerary: last.itinerary,
    errors: last.errors,
    history: state.history.slice(0, -1),
    // The row that came back is highlighted, and the page puts focus there if it was lost.
    changed: last.at,
    message: "Undid the last change.",
  };
}

/** The label for the undo button, or null when there is nothing to undo. */
export function undoLabel(state: ItineraryState): string | null {
  const last = state.history.at(-1);
  return last ? UNDO_LABELS[last.kind] : null;
}
