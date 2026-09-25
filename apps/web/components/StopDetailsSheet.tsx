"use client";

import {
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
  type RefObject,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import { preload } from "react-dom";
import { clockDateTime, formatDuration } from "../lib/format";
import { type PlacePhoto, photoForPlace } from "../lib/placePhotos";
import { type StopFactSheet, stopFacts } from "../lib/stopFacts";
import { keyStep, type Step, stepAnnouncement, takesArrows } from "../lib/stopSteps";
import { type RowView, stopName } from "../lib/timetable";
import { useMediaQuery } from "../lib/useMediaQuery";
import type { StopSteps } from "../lib/useStopDetails";
import { useSwipeSteps } from "../lib/useSwipeSteps";
import { ClockText } from "./Clock";
import { BackIcon, ForwardIcon } from "./icons";
import {
  CannotConfirm,
  FactBoard,
  ListingWords,
  PLACE_PHOTO_SIZES,
  PlacePhotoFigure,
  PlaceSummary,
} from "./PlaceParts";
import { Sheet, SheetTitleBar } from "./Sheet";
import { Subtitle } from "./StopRow";

// A stop's details, in a sheet over the day's board: a bottom sheet on phones and a centred
// panel from 768 px (Sheet), opened from the stop's photo or its Details button, or a stop on the
// map. The place's name is the title with the subtitle under it; then the photo large with its
// credit, the AI summary, the facts for the date as a small board of their own (the visit, the
// hours on that date, the dates it opens, booking and price), what the data cannot confirm, and
// the listing's own description set apart as its words (PlaceParts, shared with the place sheet).
//
// Previous and Next step through the day's stops, meals included, without closing: pills at the
// foot of the phone sheet (where the thumb is, above the home indicator) and round pills beside
// Close from 768 px, with the position ("3 of 6") between them. The arrow keys step while focus is
// in the sheet and not in a field, and a sideways swipe on the body steps on touch. The new stop's
// parts slide in from the side it came from while the sheet and the photo's frame stay put, and
// the sheet says where it is now ("Stop 4 of 6, Spanish Steps, 16:30 to 16:50").
//
// Decision: the sheet is for reading. Swap, Remove and the moves stay on the row, where the board
// shows what they changed; a second copy of them here would make the sheet a second place to
// edit from and hide the result behind it.

/** From this width the step controls sit in the head beside Close (the centred panel's width). */
const WIDE = "(min-width: 768px)";

interface StopDetailsSheetProps {
  id: string;
  open: boolean;
  row: RowView | null; // the stop shown; kept while the sheet closes, so it leaves with its content
  date: string;
  onClose: () => void;
  returnFocus: RefObject<HTMLElement | null>;
  steps?: StopSteps;
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

export function StopDetailsSheet(props: StopDetailsSheetProps) {
  const { id, open, row, date, onClose, returnFocus, steps } = props;
  const headingRef = useRef<HTMLHeadingElement>(null);
  const swipeRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const wide = useMediaQuery(WIDE);
  const name = stopName({ place: row?.place });
  const stepping = steps !== undefined && steps.count > 1 && row !== null;
  const stepped = stepping && steps.taken > 0;
  // Each stop's parts are new elements, so they slide in; the title and the photo's frame stay.
  const part = row?.stop.placeId ?? "none";
  const motion = { "--from": steps?.from ?? 1 } as CSSProperties;

  const step = (by: Step) => {
    if (!steps) return;
    const target = by === 1 ? steps.next : steps.previous;
    if (target) steps.step(by);
  };

  const swipe = useSwipeSteps({
    can: { previous: steps?.previous != null, next: steps?.next != null },
    onStep: step,
    follow: swipeRef,
    still: prefersReducedMotion,
  });

  // The arrows step while focus is anywhere in the sheet but a field that uses them.
  const onKeyDown = (event: KeyboardEvent<HTMLDialogElement>) => {
    if (!stepping || event.defaultPrevented || takesArrows(event.target)) return;
    const by = keyStep(event);
    if (by === null) return;
    event.preventDefault();
    step(by);
  };

  // The step pill that had focus last, if the last focus in the sheet was one. Noted as focus
  // arrives, because a pill that leaves the page takes its focus with it before anything can ask.
  const pillFocus = useRef<string | null>(null);
  const onFocus = (event: FocusEvent<HTMLDialogElement>) => {
    const target = event.target as HTMLElement;
    pillFocus.current = target.dataset?.step ?? null;
  };

  // Focus stays on the control that stepped. Focus in a part that stepped away (a photo credit's
  // link) would fall to the page behind the sheet; it goes to the title instead. The step controls
  // move between the foot and the head as the width crosses 768 px (a window resized, a tablet
  // turned, a zoom): a pill that had focus hands it to the same pill in its new place.
  const placed = useRef(wide);
  // biome-ignore lint/correctness/useExhaustiveDependencies: part, because each step replaces the parts.
  useLayoutEffect(() => {
    const moved = placed.current !== wide;
    placed.current = wide;
    const heading = headingRef.current;
    const dialog = heading?.closest("dialog");
    if (!open || !(stepped || moved) || !heading || !dialog) return;
    if (dialog.contains(document.activeElement)) return;
    const pill = moved ? pillFocus.current : null;
    const target = pill ? dialog.querySelector<HTMLElement>(`[data-step="${pill}"]`) : null;
    (target ?? heading).focus({ preventScroll: true });
  }, [open, stepped, part, wide]);

  // The photos a step away load while the traveler reads, so a step shows its photo at once.
  const near = stepping ? [steps.previous, steps.next] : [];
  const nearPhotos = near.flatMap((item) => (item?.place ? [photoForPlace(item.place)] : []));
  const nearKey = nearPhotos.map((photo) => photo?.src).join(" ");
  // biome-ignore lint/correctness/useExhaustiveDependencies: nearKey names the photos.
  useEffect(() => {
    if (!open) return;
    for (const photo of nearPhotos) {
      if (!photo) continue;
      preload(photo.src, {
        as: "image",
        imageSrcSet: photo.srcSet,
        imageSizes: PLACE_PHOTO_SIZES,
        fetchPriority: "low",
      });
    }
  }, [open, nearKey]);

  const controls =
    stepping && row ? (
      <StepControls row={row} steps={steps} place={wide ? "head" : "foot"} onStep={step} />
    ) : null;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      id={id}
      labelledBy={titleId}
      size="fit"
      className={`details-sheet${stepping ? " details-sheet--steps" : ""}`}
      testId="details-sheet"
      initialFocus={headingRef}
      returnFocus={returnFocus}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
      footer={wide ? null : controls}
      header={
        <SheetTitleBar
          titleId={titleId}
          titleRef={headingRef}
          title={
            <span key={part} className="details-part">
              {name}
            </span>
          }
          titleTestId="details-title"
          subtitle={row ? <Subtitle key={part} row={row} /> : null}
          headingProps={{ "data-stepped": stepped ? "true" : undefined, style: motion }}
          actions={wide ? controls : null}
          closeLabel="Close details"
          closeTestId="details-close"
          onClose={onClose}
        />
      }
    >
      {row ? (
        <div
          ref={swipeRef}
          className="details-swipe"
          data-testid="details-swipe"
          {...(stepping ? swipe : {})}
        >
          <StopDetails
            key={steps?.session ?? 0}
            row={row}
            date={date}
            photo={row.place ? photoForPlace(row.place) : null}
            part={part}
            stepped={stepped}
            motion={motion}
          />
        </div>
      ) : null}
    </Sheet>
  );
}

interface StepControlsProps {
  row: RowView;
  steps: StopSteps;
  place: "head" | "foot";
  onStep: (by: Step) => void;
}

/**
 * Previous, the position and Next. At the first or the last stop its button stays in place,
 * dimmed and still focusable (aria-disabled), so nothing moves and focus is never dropped.
 * Decision: the pills say "Previous" and "Next", not the stops' names; a pill as wide as each
 * name would move under the thumb on every step. Their accessible names are fixed too ("Next
 * stop"): a screen reader reads out a new name on the focused control, so a name that carried
 * the stop beyond would say "Pantheon" as the sheet arrives at Trevi Fountain. The live region
 * says where the sheet is, and the title shows it.
 */
function StepControls({ row, steps, place, onStep }: StepControlsProps) {
  const { previous, next, count, taken } = steps;
  const foot = place === "foot";
  const pill = foot ? "pill pill--line step-pill" : "pill pill--quiet pill--round step-pill";
  return (
    <fieldset className={`step-controls step-controls--${place}`} data-testid="details-steps">
      <legend className="sr-only">Stops on this day</legend>
      <button
        type="button"
        className={`${pill} step-pill--previous`}
        aria-label="Previous stop"
        aria-disabled={previous === null || undefined}
        onClick={() => onStep(-1)}
        data-step="previous"
        data-testid="details-previous"
      >
        <BackIcon size={foot ? 18 : 22} />
        {foot ? <span>Previous</span> : null}
      </button>
      <p className="step-position tabular" data-testid="details-position">
        <span className="sr-only">Stop </span>
        {row.index + 1} of {count}
      </p>
      <button
        type="button"
        className={`${pill} step-pill--next`}
        aria-label="Next stop"
        aria-disabled={next === null || undefined}
        onClick={() => onStep(1)}
        data-step="next"
        data-testid="details-next"
      >
        {foot ? <span>Next</span> : null}
        <ForwardIcon size={foot ? 18 : 22} />
      </button>
      {/* Decision: the sheet's own live region. The page's is behind the modal sheet, where the
          browser makes everything inert, and an inert region may not be heard. A new node per
          step, so the same words said twice (stepping back and forth) are heard twice. */}
      <div role="status" aria-live="polite" className="sr-only" data-testid="details-announcement">
        {taken > 0 ? <p key={taken}>{stepAnnouncement(row, count)}</p> : null}
      </div>
    </fieldset>
  );
}

interface StopDetailsProps {
  row: RowView;
  date: string;
  photo: PlacePhoto | null;
  part: string; // the stop's key: its parts are new elements for each stop
  stepped: boolean; // reached by a step, so the parts slide in rather than drop in
  motion: CSSProperties;
}

/**
 * The photo with its credit, the AI summary, the facts for this date in a small board of their
 * own, what the data cannot confirm, and the listing's description set apart as a quotation.
 */
// Decision: the stop's sheet shows the place's AI summary too, in the same place as the place
// sheet (under the photo, before the facts). One place reads the same wherever it is opened, the
// summary is the quickest line to take in before the facts, and each text says whose it is: the
// AI's leans under its own label, the listing's words stay last, upright, as the listing's.
function StopDetails({ row, date, photo, part, stepped, motion }: StopDetailsProps) {
  const { place, stop } = row;
  const sheet = useMemo<StopFactSheet | null>(
    () => (place ? stopFacts(place, date, { start: stop.start, end: stop.end }) : null),
    [place, date, stop.start, stop.end],
  );
  // Each part but the photo's frame is keyed by the stop, so a step brings new ones that slide in.
  return (
    <div
      className="place-details"
      data-stepped={stepped ? "true" : undefined}
      style={motion}
      data-testid="stop-details"
    >
      {/* Decision: the figure is the same element from stop to stop, so the photo's frame stays
          where it is and the next photo fades in over the last (PlacePhotoImage); only the credit
          slides in with the words. */}
      {photo ? <PlacePhotoFigure photo={photo} creditKey={part} /> : null}
      {place ? <PlaceSummary key={`${part}-summary`} placeId={place.id} /> : null}
      {sheet ? (
        <>
          <FactBoard
            key={`${part}-facts`}
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
          <CannotConfirm key={`${part}-unconfirmed`} caveats={sheet.unconfirmed} />
          <ListingWords key={`${part}-listing`} description={sheet.description} />
        </>
      ) : null}
    </div>
  );
}
