"use client";

import type { Place } from "@italy/planner";
import { type RefObject, useId, useMemo, useRef } from "react";
import { placeWhere } from "../lib/format";
import { photoForPlace } from "../lib/placePhotos";
import { placeFacts } from "../lib/stopFacts";
import {
  CannotConfirm,
  FactBoard,
  ListingWords,
  PlacePhotoFigure,
  PlaceSummary,
} from "./PlaceParts";
import { Sheet, SheetTitleBar } from "./Sheet";

// A place on its own, outside any plan, in a sheet: a bottom sheet on phones and a centred panel
// from 768 px (Sheet), opened from a highlight on the first screen. The name is the title with
// "type in neighbourhood, city" under it; then the photo large with its full credit, the AI
// summary, the facts that do not depend on a date (the typical visit, the hours by weekday, the
// dates it opens, booking when the listing states it, price and rating), what the data cannot
// confirm, and the listing's own description. It is the stop details sheet's sibling and reads
// the same (PlaceParts), without a visit or a date. Closing returns focus to the tile.

interface PlaceSheetProps {
  id: string;
  open: boolean;
  place: Place | null; // kept while the sheet closes, so it leaves with its content
  onClose: () => void;
  returnFocus: RefObject<HTMLElement | null>;
}

export function PlaceSheet({ id, open, place, onClose, returnFocus }: PlaceSheetProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const titleId = useId();
  return (
    <Sheet
      open={open}
      onClose={onClose}
      id={id}
      labelledBy={titleId}
      size="fit"
      className="details-sheet place-sheet"
      testId="place-sheet"
      initialFocus={headingRef}
      returnFocus={returnFocus}
      header={
        <SheetTitleBar
          titleId={titleId}
          titleRef={headingRef}
          title={place?.name ?? ""}
          titleTestId="place-title"
          subtitle={place ? <p className="stop-subtitle">{placeWhere(place)}</p> : null}
          closeLabel="Close details"
          closeTestId="place-close"
          onClose={onClose}
        />
      }
    >
      {place ? <PlaceDetails place={place} /> : null}
    </Sheet>
  );
}

function PlaceDetails({ place }: { place: Place }) {
  const photo = photoForPlace(place);
  const sheet = useMemo(() => placeFacts(place), [place]);
  return (
    <div className="place-details" data-testid="place-details">
      {photo ? <PlacePhotoFigure photo={photo} /> : null}
      <PlaceSummary placeId={place.id} />
      <FactBoard testId="place-fact-sheet" facts={sheet.facts} />
      <CannotConfirm caveats={sheet.unconfirmed} />
      <ListingWords description={sheet.description} />
    </div>
  );
}
