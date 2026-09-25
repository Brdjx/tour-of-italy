"use client";

import { Fragment, type RefObject, useId, useMemo, useRef } from "react";
import { clockDateTime, formatDuration } from "../lib/format";
import { type PlacePhoto, photoForPlace } from "../lib/placePhotos";
import { type StopFactSheet, stopFacts } from "../lib/stopFacts";
import type { RowView } from "../lib/timetable";
import { ClockText } from "./Clock";
import { CloseIcon } from "./icons";
import { PhotoCredit, PlacePhotoImage } from "./PlacePhotoImage";
import { Sheet } from "./Sheet";
import { Subtitle } from "./StopRow";

// A stop's details, in a sheet over the day's board: a bottom sheet on phones and a centred
// panel from 768 px (Sheet), opened from the stop's photo or its Details button. The place's
// name is the title with the subtitle under it; then the photo large with its credit, the facts
// for the date as a small board of their own (the visit, the hours on that date, the dates it
// opens, booking and price), what the data cannot confirm, and the listing's own description set
// apart as its words. Closing returns focus to the photo or button that opened it.
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
        <>
          <div className="details-sheet-heading">
            <h2
              id={titleId}
              ref={headingRef}
              tabIndex={-1}
              className="form-sheet-title t-title outline-none"
              data-testid="details-title"
            >
              {name}
            </h2>
            {row ? <Subtitle row={row} /> : null}
          </div>
          <button
            type="button"
            className="pill pill--quiet pill--round form-sheet-close"
            onClick={onClose}
            aria-label="Close details"
            data-testid="details-close"
          >
            <CloseIcon size={22} />
          </button>
        </>
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
 * The photo with its credit, the facts for this date in a small board of their own, what the
 * data cannot confirm, and the listing's description set apart as a quotation.
 */
function StopDetails({ row, date, photo }: StopDetailsProps) {
  const { place, stop } = row;
  const sheet = useMemo<StopFactSheet | null>(
    () => (place ? stopFacts(place, date, { start: stop.start, end: stop.end }) : null),
    [place, date, stop.start, stop.end],
  );
  const cannotConfirmId = useId();
  return (
    <div className="stop-details" data-testid="stop-details">
      {photo ? (
        <figure className="stop-details-photo">
          <PlacePhotoImage
            photo={photo}
            shape="wide"
            sizes="(min-width: 768px) 504px, calc(100vw - 32px)"
            eager
          />
          <figcaption>
            <PhotoCredit photo={photo} />
          </figcaption>
        </figure>
      ) : null}
      {sheet ? (
        <>
          <dl className="fact-board" data-testid="stop-fact-sheet">
            {/* Decision: the visit's own times first. The row that shows them is behind the
                sheet, and the hours below say whether this visit fits them. */}
            <div className="fact-row" data-fact="visit">
              <dt className="fact-term">Your visit</dt>
              <dd className="fact-value">
                <time className="tabular" dateTime={clockDateTime(date, stop.start)}>
                  <ClockText minutes={stop.start} />
                </time>{" "}
                to{" "}
                <time className="tabular" dateTime={clockDateTime(date, stop.end)}>
                  <ClockText minutes={stop.end} />
                </time>
                <span className="fact-note tabular">{formatDuration(stop.end - stop.start)}</span>
              </dd>
            </div>
            {sheet.facts.map((fact) => (
              <div key={fact.key} className="fact-row" data-fact={fact.key}>
                <dt className="fact-term">{fact.label}</dt>
                <dd className="fact-value">
                  {fact.numeric ? <TimesText text={fact.value} /> : fact.value}
                  {fact.note ? <span className="fact-note">{fact.note}</span> : null}
                </dd>
              </div>
            ))}
          </dl>
          {sheet.unconfirmed.length > 0 ? (
            // Decision: a heading and a named list, not a <section>: a region landmark inside
            // the sheet would repeat what its title already says.
            <div className="stop-unconfirmed">
              <h3 id={cannotConfirmId} className="stop-unconfirmed-title">
                What the data cannot confirm
              </h3>
              <ul className="stop-unconfirmed-list" aria-labelledby={cannotConfirmId}>
                {sheet.unconfirmed.map((caveat) => (
                  <li key={caveat.key} data-testid="stop-caveat">
                    {caveat.text}
                    {caveat.quote ? (
                      <>
                        {" "}
                        <q className="listing-words">{caveat.quote}</q>
                      </>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {sheet.description ? (
            <figure className="stop-listing" data-testid="stop-description">
              <figcaption className="stop-listing-source">
                The listing's description, in its own words
              </figcaption>
              <blockquote className="stop-description">{sheet.description}</blockquote>
            </figure>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/** Clock times in tabular figures with normal-width colons, like ClockText, inside a line. */
function TimesText({ text }: { text: string }) {
  const parts = text.split(":");
  return (
    <span className="tabular">
      {parts.map((part, index) =>
        index === 0 ? (
          part
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one fixed string never reorder.
          <Fragment key={index}>
            <span className="clock-colon">:</span>
            {part}
          </Fragment>
        ),
      )}
    </span>
  );
}
