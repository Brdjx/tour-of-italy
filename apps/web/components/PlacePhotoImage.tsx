"use client";

import { type CSSProperties, useState } from "react";
import type { PlacePhoto } from "../lib/placePhotos";

// A place photo from Wikimedia Commons. The frame has the photo's final shape from the start
// (a warm tile until the image arrives), so nothing moves when it loads, and the image fades in
// once. A photo of the city or a general scene sits inset on a warm mat with a label, so it can
// never pass for a photo of the place itself. A photo that fails to load leaves the tile.

interface PlacePhotoImageProps {
  photo: PlacePhoto;
  shape: "square" | "wide";
  sizes: string; // the CSS width the image is shown at, for srcset
  eager?: boolean; // the first photos on screen load at once, the rest when scrolled near
}

export function PlacePhotoImage({ photo, shape, sizes, eager = false }: PlacePhotoImageProps) {
  const [state, setState] = useState<"loading" | "loaded" | "failed">("loading");
  const own = photo.kind === "place";
  const style = { objectPosition: photo.focal } as CSSProperties;
  return (
    <span
      className={`place-photo place-photo--${shape}${own ? "" : " place-photo--matted"}`}
      data-state={state}
      data-kind={photo.kind}
    >
      {state === "failed" ? null : (
        // biome-ignore lint/performance/noImgElement: a static export cannot use next/image's optimizer; the photos ship pre-sized from Commons with their own srcset.
        <img
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
          onLoad={() => setState("loaded")}
          onError={() => setState("failed")}
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
