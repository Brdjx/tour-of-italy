"use client";

import type { PlannerContext } from "@italy/planner";
import { HIGHLIGHT_PLACE_IDS, photoForPlace } from "../lib/placePhotos";
import { PhotoCredit, PlacePhotoImage } from "./PlacePhotoImage";
import { Skeleton } from "./skeleton/Skeleton";

// A few of the places a trip can include, each with a real photo of that place and a one-line
// credit, before any plan exists: a row that scrolls sideways on phones and tablets, a grid beside
// the form from 1024 px. They sweep in from the top left to the bottom right once. They are
// examples of the data, not a promise that a trip includes them, and they are not links. Until
// the places load, square skeletons hold their place.

export function Highlights({ ctx }: { ctx: PlannerContext | null }) {
  const places = ctx
    ? HIGHLIGHT_PLACE_IDS.map((id) => ctx.placesById.get(id)).filter((place) => place !== undefined)
    : [];
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
              return (
                <li key={place.id} className="highlight" data-step={index}>
                  <figure>
                    <PlacePhotoImage photo={photo} shape="square" sizes="220px" />
                    <figcaption className="highlight-caption">
                      <span className="highlight-name">{place.name}</span>
                      <span className="highlight-city">{place.city}</span>
                      <PhotoCredit photo={photo} compact />
                    </figcaption>
                  </figure>
                </li>
              );
            })
          : HIGHLIGHT_PLACE_IDS.map((id) => (
              <li key={id} className="highlight" aria-hidden="true">
                <Skeleton className="skeleton--fill highlight-skeleton" />
              </li>
            ))}
      </ul>
    </section>
  );
}
