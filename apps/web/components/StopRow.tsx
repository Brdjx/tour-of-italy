"use client";

import { type CSSProperties, Fragment, useId, useMemo, useState } from "react";
import {
  clockDateTime,
  formatDuration,
  placeSubtitle,
  priceLabel,
  priceSymbols,
  ratingText,
} from "../lib/format";
import type { PlacePhoto } from "../lib/placePhotos";
import { type StopFactSheet, stopFacts } from "../lib/stopFacts";
import type { RowView } from "../lib/timetable";
import { ClockText } from "./Clock";
import { ChevronIcon } from "./icons";
import { PhotoCredit, PlacePhotoImage } from "./PlacePhotoImage";
import { type StopActionHandlers, StopActions } from "./StopActions";
import { TravelLeg } from "./TravelLeg";
import { WarningChips } from "./WarningChip";

// One stop on the day's board: the leg that leads to it, then the times alone in the left
// column and the place on the right (name; the meal it stands for, type and neighbourhood; visit
// length, price and rating; chips; the reason; and one line of edit actions). A few highlight
// stops per day show their own photo small beside the name (DayTimetable picks them); Details
// opens the stop in place with its photo and credit, the facts for this date, what the data
// cannot confirm, and the listing's description as the listing's own words. All text from the
// data or the AI is rendered as React text, never as HTML.

interface StopRowProps extends StopActionHandlers {
  row: RowView;
  dayIndex: number;
  date: string;
  isLast: boolean;
  dayStopCount: number;
  changed: boolean; // the last edit touched this row
  timesChanged: boolean; // the start or end moved in the last edit: the times flip
  photo: PlacePhoto | null;
  thumbnail: boolean; // one of the day's highlights: its own photo shows beside the name
  eagerPhoto: boolean; // among the first photos on screen
}

const ROLE_LABEL = { lunch: "Lunch", dinner: "Dinner" } as const;

/** "Lunch during this visit", "Lunch and dinner during this visit", or null. */
export function coveredLabel(meals: readonly string[]): string | null {
  if (meals.length === 0) return null;
  const words = meals.length > 1 ? "Lunch and dinner" : meals[0] === "lunch" ? "Lunch" : "Dinner";
  return `${words} during this visit`;
}

/** The meal a stop stands for: "Lunch", "Dinner", "Lunch during this visit", or null. */
export function roleText(row: RowView): string | null {
  const role = row.stop.role;
  return role === "visit" ? coveredLabel(row.coveredMeals) : ROLE_LABEL[role];
}

export function StopRow(props: StopRowProps) {
  const { row, dayIndex, date, isLast, dayStopCount, changed, timesChanged, photo } = props;
  const { stop, place } = row;
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const name = place?.name ?? "A place no longer in the data";
  const rating = ratingText(place?.rating ?? null);
  const price = place?.priceLevel ?? null;
  const style = { "--i": row.index } as CSSProperties;
  const ownPhoto = props.thumbnail && photo?.kind === "place" ? photo : null;
  const hasDetails = photo !== null || place !== undefined;
  const classes = ["stop-row"];
  if (row.flagged) classes.push("stop-row--flagged");
  if (changed) classes.push("stop-row--changed");
  if (open) classes.push("stop-row--open");
  return (
    <li
      id={`stop-${dayIndex}-${row.index}`}
      className={classes.join(" ")}
      style={style}
      data-testid="stop-row"
      data-place-id={stop.placeId}
      data-flagged={row.flagged ? "true" : undefined}
    >
      <TravelLeg leg={row.leg} />
      <div className="timetable-grid stop-line">
        {/* Decision: keyed by the times, so an edit that moves them remounts this element and
            its flip plays once; times that did not move keep their element and stay still. */}
        <div className="stop-gutter">
          <p
            className={`stop-times t-time${timesChanged ? " stop-times--flip" : ""}`}
            key={timesChanged ? `${stop.start}-${stop.end}` : "times"}
          >
            <time dateTime={clockDateTime(date, stop.start)} className="stop-start">
              <ClockText minutes={stop.start} />
            </time>
            <span className="sr-only"> to </span>
            <time dateTime={clockDateTime(date, stop.end)} className="stop-end">
              <ClockText minutes={stop.end} />
            </time>
          </p>
        </div>
        <div className="stop-body">
          <div className="stop-head">
            <div className="min-w-0">
              <h3 className="stop-name t-title">{name}</h3>
              <Subtitle row={row} />
              <dl className="stop-facts">
                <div>
                  <dt className="sr-only">Visit length</dt>
                  <dd className="tabular">{formatDuration(stop.end - stop.start)}</dd>
                </div>
                {price === null ? null : (
                  <div>
                    <dt className="sr-only">Price</dt>
                    <dd>
                      <span aria-hidden="true">{priceSymbols(price)}</span>
                      <span className="sr-only">{priceLabel(price)}</span>
                    </dd>
                  </div>
                )}
                {rating === null ? null : (
                  <div>
                    <dt className="sr-only">Rating</dt>
                    <dd className="tabular">Rated {rating}</dd>
                  </div>
                )}
              </dl>
            </div>
            {ownPhoto && !open ? (
              <button
                type="button"
                className="stop-thumb"
                onClick={() => setOpen(true)}
                aria-expanded={false}
                aria-controls={detailsId}
                aria-label={`Photo and details of ${name}`}
                data-testid="stop-thumb"
              >
                <PlacePhotoImage
                  photo={ownPhoto}
                  shape="square"
                  sizes="72px"
                  eager={props.eagerPhoto}
                />
              </button>
            ) : null}
          </div>
          <WarningChips chips={row.chips} />
          {row.reason ? <Reason text={row.reason} ai={stop.reasonSource === "ai"} /> : null}
          {hasDetails && open ? (
            <StopDetails id={detailsId} row={row} date={date} photo={photo} />
          ) : null}
          <StopActions
            name={name}
            canRemove={dayStopCount > 1}
            canMoveUp={row.index > 0}
            canMoveDown={!isLast}
            onSwap={props.onSwap}
            onRemove={props.onRemove}
            onMove={props.onMove}
            details={
              hasDetails ? (
                <button
                  type="button"
                  className="stop-action stop-action--details"
                  aria-expanded={open}
                  aria-controls={detailsId}
                  aria-label={`${open ? "Hide" : "Show"} details of ${name}`}
                  onClick={() => setOpen((now) => !now)}
                  data-testid="details-button"
                >
                  Details
                  <ChevronIcon
                    size={16}
                    className={`stop-action-chevron${open ? " stop-action-chevron--open" : ""}`}
                  />
                </button>
              ) : null
            }
          />
        </div>
      </div>
    </li>
  );
}

/**
 * "Lunch, restaurant in Campo de' Fiori": the meal the stop stands for, in ink, starts the line,
 * then the type and neighbourhood in muted text. A plain visit shows only the type and place.
 */
function Subtitle({ row }: { row: RowView }) {
  const role = roleText(row);
  const where = row.place ? placeSubtitle(row.place) : null;
  if (!role && !where) return null;
  return (
    <p className="stop-subtitle">
      {role ? (
        <span className="stop-role" data-testid="meal-label">
          {role}
        </span>
      ) : null}
      {role && where ? `, ${lowerFirst(where)}` : where}
    </p>
  );
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/** The one line of commentary on a stop. It leans (the slant axis); checked facts stand upright. */
function Reason({ text, ai }: { text: string; ai: boolean }) {
  return (
    <p className="stop-reason" data-testid="stop-reason">
      <span aria-hidden="true" className={`reason-mark${ai ? " reason-mark--ai" : ""}`} />
      <span className="t-lean">
        <span className="sr-only">
          {ai ? "Why, from the AI planner: " : "Why, from the rules: "}
        </span>
        {text}
      </span>
    </p>
  );
}

interface StopDetailsProps {
  id: string;
  row: RowView;
  date: string;
  photo: PlacePhoto | null;
}

/**
 * An opened stop: the photo with its credit, the facts for this date in a small board of their
 * own, what the data cannot confirm, and the listing's description set apart as a quotation.
 */
function StopDetails({ id, row, date, photo }: StopDetailsProps) {
  const { place, stop } = row;
  const sheet = useMemo<StopFactSheet | null>(
    () => (place ? stopFacts(place, date, { start: stop.start, end: stop.end }) : null),
    [place, date, stop.start, stop.end],
  );
  const cannotConfirmId = useId();
  return (
    <div id={id} className="stop-details" data-testid="stop-details">
      {photo ? (
        <figure className="stop-details-photo">
          <PlacePhotoImage photo={photo} shape="wide" sizes="(min-width: 640px) 560px, 92vw" />
          <figcaption>
            <PhotoCredit photo={photo} />
          </figcaption>
        </figure>
      ) : null}
      {sheet ? (
        <>
          <dl className="stop-sheet" data-testid="stop-fact-sheet">
            {sheet.facts.map((fact) => (
              <div key={fact.key} className="stop-sheet-row" data-fact={fact.key}>
                <dt className="stop-sheet-term">{fact.label}</dt>
                <dd className="stop-sheet-value">
                  {fact.numeric ? <TimesText text={fact.value} /> : fact.value}
                  {fact.note ? <span className="stop-sheet-note">{fact.note}</span> : null}
                </dd>
              </div>
            ))}
          </dl>
          {sheet.unconfirmed.length > 0 ? (
            // Decision: a heading and a named list, not a <section>: a region landmark per
            // opened stop would crowd a screen reader's landmark list with the same name.
            <div className="stop-unconfirmed">
              <h4 id={cannotConfirmId} className="stop-unconfirmed-title">
                What the data cannot confirm
              </h4>
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
