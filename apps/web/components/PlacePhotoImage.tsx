"use client";

import { type CSSProperties, useEffect, useState } from "react";
import type { PlacePhoto } from "../lib/placePhotos";

// A place photo from Wikimedia Commons. The frame has the photo's final shape from the start
// (a warm tile until the image arrives), so nothing moves when it loads, and the image fades in
// once. A photo of the city or a general scene sits inset on a warm mat with a label, so it can
// never pass for a photo of the place itself. A photo that fails to load leaves the tile.
// Given a new photo (a stop's details stepping to the next stop), the frame stays and the new
// photo fades in over the last one, so a photo that is at hand (the sheet loads the photos a
// step away) replaces the last without an empty tile between them.
// Decision: the last photo waits under the new one for 120 ms and then fades out whether the new
// one has come or not (timetable.css). Held until the new one arrived, a slow
// connection would leave the last place's photo under the next place's name, which is not true.

/** The last photo is gone by then: its 120 ms wait and 180 ms fade (--dur-fade), and a frame. */
const UNDER_MS = 320;

type LoadState = "loading" | "loaded" | "failed";

interface PlacePhotoImageProps {
  photo: PlacePhoto;
  shape: "square" | "wide";
  sizes: string; // the CSS width the image is shown at, for srcset
  eager?: boolean; // the first photos on screen load at once, the rest when scrolled near
}

export function PlacePhotoImage({ photo, shape, sizes, eager = false }: PlacePhotoImageProps) {
  const [shown, setShown] = useState<{ photo: PlacePhoto; state: LoadState }>({
    photo,
    state: "loading",
  });
  // The last photo that arrived, under a new one until that has faded in.
  const [under, setUnder] = useState<PlacePhoto | null>(null);
  if (shown.photo.src !== photo.src) {
    setUnder(shown.state === "loaded" ? shown.photo : under);
    setShown({ photo, state: "loading" });
  }
  const state = shown.photo.src === photo.src ? shown.state : "loading";
  useEffect(() => {
    if (!under) return;
    const timer = window.setTimeout(() => setUnder(null), UNDER_MS);
    return () => window.clearTimeout(timer);
  }, [under]);
  const settle = (next: LoadState) => () =>
    setShown((current) =>
      current.photo.src === photo.src ? { ...current, state: next } : current,
    );
  const own = photo.kind === "place";
  const style = { objectPosition: photo.focal } as CSSProperties;
  return (
    <span
      className={`place-photo place-photo--${shape}${own ? "" : " place-photo--matted"}`}
      data-state={state}
      data-kind={photo.kind}
    >
      {under ? (
        // biome-ignore lint/performance/noImgElement: as below; this is the last photo, leaving.
        <img
          key={`under-${under.src}`}
          className="place-photo-img place-photo-under"
          src={under.src}
          srcSet={under.srcSet}
          sizes={sizes}
          width={under.width}
          height={under.height}
          alt=""
          aria-hidden="true"
          style={{ objectPosition: under.focal }}
          data-testid="photo-under"
        />
      ) : null}
      {state === "failed" ? null : (
        // biome-ignore lint/performance/noImgElement: a static export cannot use next/image's optimizer; the photos ship pre-sized from Commons with their own srcset.
        <img
          key={photo.src}
          className="place-photo-img"
          src={photo.src}
          srcSet={photo.srcSet}
          sizes={sizes}
          width={photo.width}
          height={photo.height}
          alt={photo.alt}
          style={style}
          loading={eager ? "eager" : "lazy"}
          decoding="async"
          onLoad={settle("loaded")}
          onError={settle("failed")}
        />
      )}
      {own ? null : (
        <span className="place-photo-chip" aria-hidden="true">
          {photo.kind === "city" ? "City photo" : "General photo"}
        </span>
      )}
    </span>
  );
}

/**
 * "Photo: A. Rossi, CC BY-SA 3.0, Wikimedia Commons": the author, the licence linked to the
 * licence itself (the 2.x and 3.0 licences ask for its URL), and the source linked to the photo's
 * Commons page. A city or general photo says so first. Shown in full wherever a photo is large:
 * the place and stop sheets; "About this data" lists every photo's credit the same way.
 */
export function PhotoCredit({ photo }: { photo: PlacePhoto }) {
  return (
    <p className="photo-credit">
      {photo.note ? <span className="photo-credit-note">{photo.note} </span> : null}
      <span>Photo: {photo.author}, </span>
      <LicenceLink photo={photo} />
      <span>, </span>
      <a href={photo.sourceUrl} target="_blank" rel="noreferrer noopener">
        Wikimedia Commons
      </a>
    </p>
  );
}

/** The licence, linked to its text when it has one (public domain has none). */
export function LicenceLink({ photo }: { photo: Pick<PlacePhoto, "license" | "licenseUrl"> }) {
  return photo.licenseUrl ? (
    <a href={photo.licenseUrl} target="_blank" rel="noreferrer noopener">
      {photo.license}
    </a>
  ) : (
    <span>{photo.license}</span>
  );
}
