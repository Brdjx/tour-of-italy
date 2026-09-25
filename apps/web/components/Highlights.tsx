"use client";

import type { Place, PlannerContext } from "@italy/planner";
import { useId, useRef, useState } from "react";
import { HIGHLIGHT_PLACE_IDS, photoForPlace } from "../lib/placePhotos";
import { ChevronIcon } from "./icons";
import { PlacePhotoImage } from "./PlacePhotoImage";
import { PlaceSheet } from "./PlaceSheet";
import { Skeleton } from "./skeleton/Skeleton";

// A few of the places a trip can include, each with a real photo of that place, before any plan
// exists: a row that scrolls sideways on phones and tablets, a grid beside the form from 1024 px.
// They sweep in from the top left to the bottom right once. They are examples of the data, not a
// promise that a trip includes them. Each tile is one button that opens the place in a sheet
// (PlaceSheet): the photo large with its full credit, the AI summary, the facts and the listing's
// own words. Until the places load, square skeletons hold their place.
//
// Decision: no credit line under the tiles. The photos are CC BY and CC BY-SA (and a few public
// domain), which allow the attribution "in any reasonable manner based on the medium"; the full
// credit (author, licence linked to its text, the Commons page) is one tap away in the tile's
// sheet, and "About this data" lists every photo's credit. The tile's name says the sheet holds
// the credit, so it is never hidden from anyone who looks for it.

export function Highlights({ ctx }: { ctx: PlannerContext | null }) {
  const places = ctx
    ? HIGHLIGHT_PLACE_IDS.map((id) => ctx.placesById.get(id)).filter((place) => place !== undefined)
    : [];
  const sheetId = useId();
  // The place in the sheet. Kept after the sheet closes, so it leaves with its content.
  const [shown, setShown] = useState<{ place: Place; open: boolean } | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  return (
    <section className="highlights" aria-labelledby="highlights-title" data-testid="highlights">
      <h2 id="highlights-title" className="highlights-title">
        A few of the places a trip can include
      </h2>
      <ul className="highlights-grid" aria-busy={ctx ? undefined : true}>
        {ctx
          ? places.map((place, index) => {
              const photo = photoForPlace(place);
              if (!photo) return null;
              const open = shown?.open === true && shown.place.id === place.id;
              return (
                <li key={place.id} className="highlight" data-step={index}>
                  <button
                    type="button"
                    className="highlight-button"
                    aria-label={`${place.name}, ${place.city}: photo, details and credit`}
                    aria-haspopup="dialog"
                    aria-expanded={open}
                    aria-controls={sheetId}
                    onClick={(event) => {
                      opener.current = event.currentTarget;
                      setShown({ place, open: true });
                    }}
                    data-testid="highlight-button"
                  >
                    <PlacePhotoImage photo={photo} shape="square" sizes="220px" />
                    <span className="highlight-name">
                      {place.name}
                      <ChevronIcon size={14} className="highlight-chevron" />
                    </span>
                    <span className="highlight-city">{place.city}</span>
                  </button>
                </li>
              );
            })
          : HIGHLIGHT_PLACE_IDS.map((id) => (
              <li key={id} className="highlight" aria-hidden="true">
                <Skeleton className="skeleton--fill highlight-skeleton" />
              </li>
            ))}
      </ul>
      <PlaceSheet
        id={sheetId}
        open={shown?.open === true}
        place={shown?.place ?? null}
        onClose={() => setShown((current) => (current ? { ...current, open: false } : null))}
        returnFocus={opener}
      />
    </section>
  );
}
