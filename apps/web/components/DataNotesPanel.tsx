"use client";

import { useId, useRef, useState } from "react";
import type { TripData } from "../lib/tripData";
import { AboutDataSheet } from "./AboutDataSheet";

// "About this data": a quiet link at the foot of the page, on the first screen and under a plan,
// that opens the data notes over the page (AboutDataSheet): what the planner found in the source
// data and how each issue was handled, from GET /api/data-issues (or rebuilt from the places when
// that is missing), with the places, the hours, how a plan is made and every credit.

export function DataNotesPanel({ data }: { data: Pick<TripData, "places" | "ctx" | "summary"> }) {
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const sheetId = useId();
  return (
    <div className="data-notes" data-testid="data-notes">
      {/* Decision: no count on the link. "(23)" read as 23 problems; the overlay's headline says
          how the data stands in words, and its list names each kind of note. */}
      <button
        ref={opener}
        type="button"
        className="data-notes-link"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={sheetId}
        onClick={() => setOpen(true)}
        data-testid="data-notes-link"
      >
        About this data
      </button>
      <AboutDataSheet
        id={sheetId}
        open={open}
        onClose={() => setOpen(false)}
        returnFocus={opener}
        places={data.places}
        ctx={data.ctx}
        summary={data.summary}
      />
    </div>
  );
}
