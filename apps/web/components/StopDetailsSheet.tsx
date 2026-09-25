"use client";

import { type RefObject, useId, useMemo, useRef } from "react";
import { clockDateTime, formatDuration } from "../lib/format";
import { type PlacePhoto, photoForPlace } from "../lib/placePhotos";
import { type StopFactSheet, stopFacts } from "../lib/stopFacts";
import type { RowView } from "../lib/timetable";
import { ClockText } from "./Clock";
import {
  CannotConfirm,
  FactBoard,
  ListingWords,
  PlacePhotoFigure,
  PlaceSummary,
} from "./PlaceParts";
import { Sheet, SheetTitleBar } from "./Sheet";
import { Subtitle } from "./StopRow";

// A stop's details, in a sheet over the day's board: a bottom sheet on phones and a centred
// panel from 768 px (Sheet), opened from the stop's photo or its Details button. The place's
// name is the title with the subtitle under it; then the photo large with its credit, the AI
// summary, the facts for the date as a small board of their own (the visit, the hours on that
// date, the dates it opens, booking and price), what the data cannot confirm, and the listing's
// own description set apart as its words (PlaceParts, shared with the place sheet). Closing
// returns focus to the photo or button that opened it.
//
// Decision: the sheet is for reading. Swap, Remove and the moves stay on the row, where the board
// shows what they changed; a second copy of them here would make the sheet a second place to
// edit from and hide the result behind it.

interface StopDetailsSheetProps {
  id: string;
  open: boolean;
  row: RowView | null; // the stop shown; kept while the sheet closes, so it leaves with its content
  date: string;
  onClose: () => void;
  returnFocus: RefObject<HTMLElement | null>;
}

export function StopDetailsSheet(props: StopDetailsSheetProps) {
  const { id, open, row, date, onClose, returnFocus } = props;
  const headingRef = useRef<HTMLHeadingElement>(null);
  const titleId = useId();
  const name = row?.place?.name ?? "A place no longer in the data";
  return (
    <Sheet
      open={open}
      onClose={onClose}
      id={id}
      labelledBy={titleId}
      size="fit"
      className="details-sheet"
      testId="details-sheet"
      initialFocus={headingRef}
      returnFocus={returnFocus}
      header={
        <SheetTitleBar
          titleId={titleId}
          titleRef={headingRef}
          title={name}
          titleTestId="details-title"
          subtitle={row ? <Subtitle row={row} /> : null}
          closeLabel="Close details"
          closeTestId="details-close"
          onClose={onClose}
        />
      }
    >
      {row ? (
        <StopDetails row={row} date={date} photo={row.place ? photoForPlace(row.place) : null} />
      ) : null}
    </Sheet>
  );
}

interface StopDetailsProps {
  row: RowView;
  date: string;
  photo: PlacePhoto | null;
}

/**
 * The photo with its credit, the AI summary, the facts for this date in a small board of their
 * own, what the data cannot confirm, and the listing's description set apart as a quotation.
 */
// Decision: the stop's sheet shows the place's AI summary too, in the same place as the place
// sheet (under the photo, before the facts). One place reads the same wherever it is opened, the
// summary is the quickest line to take in before the facts, and each text says whose it is: the
// AI's leans under its own label, the listing's words stay last, upright, as the listing's.
function StopDetails({ row, date, photo }: StopDetailsProps) {
  const { place, stop } = row;
  const sheet = useMemo<StopFactSheet | null>(
    () => (place ? stopFacts(place, date, { start: stop.start, end: stop.end }) : null),
    [place, date, stop.start, stop.end],
  );
  return (
    <div className="place-details" data-testid="stop-details">
      {photo ? <PlacePhotoFigure photo={photo} /> : null}
      {place ? <PlaceSummary placeId={place.id} /> : null}
      {sheet ? (
        <>
          <FactBoard
            testId="stop-fact-sheet"
            facts={sheet.facts}
            // Decision: the visit's own times first. The row that shows them is behind the
            // sheet, and the hours below say whether this visit fits them.
            lead={{
              key: "visit",
              label: "Your visit",
              value: (
                <>
                  <time className="tabular" dateTime={clockDateTime(date, stop.start)}>
                    <ClockText minutes={stop.start} />
                  </time>{" "}
                  to{" "}
                  <time className="tabular" dateTime={clockDateTime(date, stop.end)}>
                    <ClockText minutes={stop.end} />
                  </time>
                  <span className="fact-note tabular">{formatDuration(stop.end - stop.start)}</span>
                </>
              ),
            }}
          />
          <CannotConfirm caveats={sheet.unconfirmed} />
          <ListingWords description={sheet.description} />
        </>
      ) : null}
    </div>
  );
}
