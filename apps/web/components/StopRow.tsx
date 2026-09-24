"use client";

import { type CSSProperties, useId, useState } from "react";
import {
  clockDateTime,
  formatDuration,
  placeSubtitle,
  priceLabel,
  priceSymbols,
  ratingText,
} from "../lib/format";
import type { PlacePhoto } from "../lib/placePhotos";
import type { RowView } from "../lib/timetable";
import { ClockText } from "./Clock";
import { ChevronIcon } from "./icons";
import { PhotoCredit, PlacePhotoImage } from "./PlacePhotoImage";
import { type StopActionHandlers, StopActions, StopMoves } from "./StopActions";
import { TravelLeg } from "./TravelLeg";
import { WarningChips } from "./WarningChip";

// One stop on the day's board: the leg that leads to it, then the times in the left column and
// the place on the right (meal label, name, type and neighbourhood, visit length, price, rating,
// chips, the reason, and the edit actions). A stop with a photo of its own shows it small beside
// the name; Details opens the stop in place with the dataset's description and the photo at
// full width with its credit (a city or general photo, clearly labelled, when the place has none).
// All text from the data or the AI is rendered as React text, never as HTML.

interface StopRowProps extends StopActionHandlers {
  row: RowView;
  dayIndex: number;
  date: string;
  isLast: boolean;
  dayStopCount: number;
  changed: boolean; // the last edit touched this row
  timesChanged: boolean; // the start or end moved in the last edit: the times flip
  photo: PlacePhoto | null;
  eagerPhoto: boolean; // among the first photos on screen
}

const ROLE_LABEL = { lunch: "Lunch", dinner: "Dinner" } as const;

/** "Lunch during this visit", "Lunch and dinner during this visit", or null. */
export function coveredLabel(meals: readonly string[]): string | null {
  if (meals.length === 0) return null;
  const words = meals.length > 1 ? "Lunch and dinner" : meals[0] === "lunch" ? "Lunch" : "Dinner";
  return `${words} during this visit`;
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
  const ownPhoto = photo?.kind === "place" ? photo : null;
  const description = place?.description.trim() ?? "";
  const hasDetails = photo !== null || description !== "";
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
          <StopMoves
            name={name}
            canMoveUp={row.index > 0}
            canMoveDown={!isLast}
            onMove={props.onMove}
          />
        </div>
        <div className="stop-body">
          <div className="stop-head">
            <div className="min-w-0">
              <RoleLabel row={row} />
              <h3 className="stop-name t-title">{name}</h3>
              {place ? <p className="stop-subtitle">{placeSubtitle(place)}</p> : null}
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
                  sizes="(min-width: 640px) 96px, 72px"
                  eager={props.eagerPhoto}
                />
              </button>
            ) : null}
          </div>
          <WarningChips chips={row.chips} />
          {row.reason ? <Reason text={row.reason} ai={stop.reasonSource === "ai"} /> : null}
          {hasDetails && open ? (
            <div id={detailsId} className="stop-details" data-testid="stop-details">
              {photo ? (
                <figure className="stop-details-photo">
                  <PlacePhotoImage
                    photo={photo}
                    shape="wide"
                    sizes="(min-width: 640px) 560px, 92vw"
                  />
                  <figcaption>
                    <PhotoCredit photo={photo} />
                  </figcaption>
                </figure>
              ) : null}
              {description ? <p className="stop-description">{description}</p> : null}
            </div>
          ) : null}
          <StopActions
            name={name}
            canRemove={dayStopCount > 1}
            onSwap={props.onSwap}
            onRemove={props.onRemove}
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

function RoleLabel({ row }: { row: RowView }) {
  const role = row.stop.role;
  const text = role === "visit" ? coveredLabel(row.coveredMeals) : ROLE_LABEL[role];
  if (!text) return null;
  return (
    <p className="stop-role t-label" data-testid="meal-label">
      {text}
    </p>
  );
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
