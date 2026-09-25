"use client";

import { Fragment, type ReactNode, useId } from "react";
import type { PlacePhoto } from "../lib/placePhotos";
import { summaryForPlace } from "../lib/placeSummaries";
import type { StopCaveat, StopFact } from "../lib/stopFacts";
import { PhotoCredit, PlacePhotoImage } from "./PlacePhotoImage";

// The parts a place is read in, shared by the stop details sheet (a stop on a date) and the place
// sheet (a highlight, with no date): the photo large with its whole credit, the AI summary set
// apart as the AI's, the facts as a small board of hairline rows, what the data cannot confirm,
// and the listing's own description set apart as its words. Each part is one child of
// .place-details, so the sheet's arrival staggers them (details.css).

/** The photo at 3:2 with its full credit: author, licence linked to its text, Commons page. */
export function PlacePhotoFigure({ photo }: { photo: PlacePhoto }) {
  return (
    <figure className="place-details-photo">
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
  );
}

/** The label every AI summary carries, in the sheets and in "About this data". */
export const SUMMARY_LABEL = "Summary by AI, from the listing";

/**
 * The place's AI summary, labelled as the AI's reading of the listing, or nothing when the saved
 * summaries have none for it. It leans, like the AI's reason on a stop: commentary leans, checked
 * facts and the listing's own words stand upright.
 */
export function PlaceSummary({ placeId }: { placeId: string }) {
  const text = summaryForPlace(placeId);
  if (!text) return null;
  return (
    <figure className="place-summary" data-testid="place-summary">
      <figcaption className="place-summary-source">
        <span aria-hidden="true" className="reason-mark reason-mark--ai" />
        {SUMMARY_LABEL}
      </figcaption>
      <p className="place-summary-text t-lean">{text}</p>
    </figure>
  );
}

/** A fact board row: the term, the value (or a week of hours), and a checked note under it. */
interface FactRow {
  key: string;
  label: string;
  value: ReactNode;
}

/** The facts as a small board of hairline rows, term in the muted label role. */
export function FactBoard({
  facts,
  lead,
  testId,
}: {
  facts: readonly StopFact[];
  lead?: FactRow; // a row before the facts (the stop's own visit)
  testId: string;
}) {
  return (
    <dl className="fact-board" data-testid={testId}>
      {lead ? (
        <div className="fact-row" data-fact={lead.key}>
          <dt className="fact-term">{lead.label}</dt>
          <dd className="fact-value">{lead.value}</dd>
        </div>
      ) : null}
      {facts.map((fact) => (
        <div key={fact.key} className="fact-row" data-fact={fact.key}>
          <dt className="fact-term">{fact.label}</dt>
          <dd className="fact-value">
            {fact.week ? (
              <ul className="week-hours">
                {fact.week.map((row) => (
                  <li key={row.days}>
                    <span className="week-days">{row.days}</span>
                    {row.hours ? <TimesText text={row.hours} /> : <span>Closed</span>}
                  </li>
                ))}
              </ul>
            ) : fact.numeric ? (
              <TimesText text={fact.value} />
            ) : (
              fact.value
            )}
            {fact.note ? <span className="fact-note">{fact.note}</span> : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** What the data cannot confirm, under its own heading, each with the caution square. */
export function CannotConfirm({ caveats }: { caveats: readonly StopCaveat[] }) {
  const titleId = useId();
  if (caveats.length === 0) return null;
  // Decision: a heading and a named list, not a <section>: a region landmark inside the sheet
  // would repeat what its title already says.
  return (
    <div className="stop-unconfirmed">
      <h3 id={titleId} className="stop-unconfirmed-title">
        What the data cannot confirm
      </h3>
      <ul className="stop-unconfirmed-list" aria-labelledby={titleId}>
        {caveats.map((caveat) => (
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
  );
}

/** The listing's own description, as a quotation captioned as its words. */
export function ListingWords({ description }: { description: string | null }) {
  if (!description) return null;
  return (
    <figure className="stop-listing" data-testid="stop-description">
      <figcaption className="stop-listing-source">
        The listing's description, in its own words
      </figcaption>
      <blockquote className="stop-description">{description}</blockquote>
    </figure>
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
