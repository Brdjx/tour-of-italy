"use client";

import { type RefObject, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { Step } from "./stopSteps";
import type { RowView } from "./timetable";

// Which stop's details sheet is open, for everything that can open it: the day's board (a
// stop's photo or Details) and the day's map (a marker or its popup), on the page or full
// screen. One sheet serves the day, so the board and the map open the same sheet on the same
// stop. Inside it the traveler steps to the previous or next stop of the day (meals are stops),
// and the board's Details for the stop shown says it is the one open.
//
// Decision: closing gives focus to the stop now shown, on what opened the sheet. Opened from the
// board and stepped from stop 2 to stop 5, focus lands on stop 5's Details, brought into view;
// opened from a marker, on stop 5's marker in the same map (on the page or full screen). Closed
// on the stop it opened on, focus goes back to the very control that opened it (the photo, say).
// The sheet is a viewer over the day's list, like a photo viewer over its grid: the traveler
// has moved through the list, and landing back on stop 2 would lose that place and send a
// keyboard or screen reader user back through stops they have already read. The ARIA dialog
// pattern allows another element when it is the more logical place to continue.
//
// Decision: a stop is its place in the day's order, with its place's id. A day can visit one
// place twice (the planner reports it rather than refusing it), so the id alone would send Next
// back to the first visit. The id finds the stop again when the day is rebuilt around it.

/** A stop of the day: where it is in the day's order, and its place. */
export interface StopRef {
  index: number;
  placeId: string;
}

/** The control for another stop, of the same kind as the one that opened the sheet. */
export type FindOpener = (stop: StopRef) => HTMLElement | null;

/** What the board and the map need to open the sheet and to say it is open. */
export interface StopDetailsControl {
  id: string; // the sheet's id, for aria-controls
  openIndex: number | null; // the stop whose sheet is open now, by its place in the day
  open: (stop: StopRef, opener: HTMLElement, find?: FindOpener) => void;
}

/** Stepping through the day's stops in the sheet. */
export interface StopSteps {
  count: number; // the stops in the day
  previous: RowView | null; // the stop a step back, or null at the first
  next: RowView | null; // the stop a step on, or null at the last
  from: Step; // the side the stop shown came in from: 1 from the right (it was next), -1 the left
  taken: number; // steps since the sheet opened: 0 is the stop it opened on
  session: number; // a new number each time the sheet opens
  step: (by: Step) => void;
}

/** What StopDetailsSheet needs, but the date. */
export interface StopDetailsSheetState {
  id: string;
  open: boolean;
  row: RowView | null; // the stop shown; kept while the sheet closes, so it leaves with its content
  onClose: () => void;
  returnFocus: RefObject<HTMLElement | null>;
  steps: StopSteps;
}

export interface StopDetails {
  control: StopDetailsControl;
  sheet: StopDetailsSheetState;
}

interface Shown extends StopRef {
  open: boolean;
  from: Step;
  steps: number;
  session: number;
}

interface Origin {
  stop: StopRef;
  opener: HTMLElement;
  find: FindOpener | undefined;
}

/** Where a stop is in the day now: at its index while that is still its place, else found by it. */
function positionOf(rows: readonly RowView[], stop: StopRef): number {
  if (rows[stop.index]?.stop.placeId === stop.placeId) return stop.index;
  return rows.findIndex((item) => item.stop.placeId === stop.placeId);
}

export function useStopDetails(rows: readonly RowView[]): StopDetails {
  const id = useId();
  // Decision: the stop is kept after the sheet closes, so it leaves with its content instead of
  // emptying first; found again by its place when the view is rebuilt.
  const [shown, setShown] = useState<Shown | null>(null);
  const origin = useRef<Origin | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const position = shown ? positionOf(rows, shown) : -1;
  const row = rows[position] ?? null;
  const open = shown?.open === true && row !== null;
  // What the handlers below read, so they keep one identity for the life of the sheet.
  const now = useRef({ rows, shown });
  now.current = { rows, shown };
  // A stop that leaves the day while its sheet is open closes the sheet for good. Without this
  // the sheet would only look closed, and open again by itself if the place came back.
  useEffect(() => {
    if (shown?.open && row === null) setShown({ ...shown, open: false });
  }, [shown, row]);
  const openSheet = useCallback((stop: StopRef, from: HTMLElement, find?: FindOpener) => {
    origin.current = { stop, opener: from, find };
    returnFocus.current = from;
    setShown((current) => ({
      index: stop.index,
      placeId: stop.placeId,
      open: true,
      from: 1,
      steps: 0,
      session: (current?.session ?? 0) + 1,
    }));
  }, []);
  const step = useCallback((by: Step) => {
    setShown((current) => {
      if (!current?.open) return current;
      const list = now.current.rows;
      const at = positionOf(list, current);
      const target = at < 0 ? undefined : list[at + by];
      if (!target) return current;
      const index = at + by;
      return {
        ...current,
        index,
        placeId: target.stop.placeId,
        from: by,
        steps: current.steps + 1,
      };
    });
  }, []);
  const close = useCallback(() => {
    const { rows: list, shown: current } = now.current;
    const first = origin.current;
    // Worked out as the sheet closes, when the board and the map show the stops they will keep.
    if (current && first) {
      const at = positionOf(list, current);
      const stop = { index: at, placeId: current.placeId };
      returnFocus.current =
        at === positionOf(list, first.stop) ? first.opener : (first.find?.(stop) ?? first.opener);
    }
    setShown((value) => (value ? { ...value, open: false } : value));
  }, []);
  const openIndex = open ? position : null;
  const control = useMemo(() => ({ id, openIndex, open: openSheet }), [id, openIndex, openSheet]);
  return {
    control,
    sheet: {
      id,
      open,
      row,
      onClose: close,
      returnFocus,
      steps: {
        count: rows.length,
        previous: position > 0 ? (rows[position - 1] ?? null) : null,
        next: position >= 0 ? (rows[position + 1] ?? null) : null,
        from: shown?.from ?? 1,
        taken: shown?.steps ?? 0,
        session: shown?.session ?? 0,
        step,
      },
    },
  };
}
