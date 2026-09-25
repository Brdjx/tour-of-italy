"use client";

import { type RefObject, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { RowView } from "./timetable";

// Which stop's details sheet is open, for everything that can open it: the day's board (a
// stop's photo or Details) and the day's map (a marker or its popup), on the page or full
// screen. One sheet serves the day, so the board and the map open the same sheet on the same
// stop, and closing it gives focus back to whatever opened it.

/** What the board and the map need to open the sheet and to say it is open. */
export interface StopDetailsControl {
  id: string; // the sheet's id, for aria-controls
  openPlaceId: string | null; // the stop whose sheet is open now
  open: (placeId: string, opener: HTMLElement) => void;
}

export interface StopDetails {
  control: StopDetailsControl;
  open: boolean;
  row: RowView | null; // the stop shown; kept while the sheet closes, so it leaves with its content
  close: () => void;
  returnFocus: RefObject<HTMLElement | null>;
}

export function useStopDetails(rows: readonly RowView[]): StopDetails {
  const id = useId();
  // Decision: the stop is kept after the sheet closes, so it leaves with its content instead of
  // emptying first; keyed by place, so a rebuilt view still finds it.
  const [shown, setShown] = useState<{ placeId: string; open: boolean } | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const row = shown ? (rows.find((item) => item.stop.placeId === shown.placeId) ?? null) : null;
  const open = shown?.open === true && row !== null;
  // A stop that leaves the day while its sheet is open closes the sheet for good. Without this
  // the sheet would only look closed, and open again by itself if the place came back.
  useEffect(() => {
    if (shown?.open && row === null) setShown({ ...shown, open: false });
  }, [shown, row]);
  const openSheet = useCallback((placeId: string, from: HTMLElement) => {
    opener.current = from;
    setShown({ placeId, open: true });
  }, []);
  const close = useCallback(() => {
    setShown((current) => (current ? { ...current, open: false } : current));
  }, []);
  const openPlaceId = open && row ? row.stop.placeId : null;
  const control = useMemo(
    () => ({ id, openPlaceId, open: openSheet }),
    [id, openPlaceId, openSheet],
  );
  return { control, open, row, close, returnFocus: opener };
}
