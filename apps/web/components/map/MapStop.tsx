"use client";

import {
  type CSSProperties,
  type FocusEvent,
  type PointerEvent,
  type Ref,
  type RefObject,
  type TouchEvent,
  useRef,
} from "react";
import type { PopupPlacement } from "../../lib/mapGeometry";
import { type MapPoint, roleWord, stopLabel } from "../../lib/mapPoints";
import { ClockText } from "../Clock";
import { ChevronIcon } from "../icons";

// One stop on the map, rendered into the element MapLibre moves with the map: a button holding
// the numbered disc, named like the board's row ("Stop 2, Borghese Gallery, 10:50 to 12:50,
// lunch"), and, while it is shown, the stop's popup beside it. The popup is inside the same
// element as the disc, so it moves with the map and the pointer can travel from the disc into
// it without leaving the stop. DayMapInner decides when the popup shows; this only draws it.

/** A touch that moves less than this, in px, is a tap rather than a drag. */
const TAP_SLOP = 10;

export interface MapStopHandlers {
  onPointerEnter: (index: number, event: PointerEvent) => void;
  onPointerLeave: (index: number, event: PointerEvent) => void;
  onPointerDown: (event: PointerEvent) => void;
  onFocus: (index: number, event: FocusEvent<HTMLButtonElement>) => void;
  onBlur: (index: number, event: FocusEvent) => void;
  onPress: (index: number) => void; // the disc was clicked, tapped or pressed with Enter
  onDetails: (index: number) => void; // the popup was clicked or tapped
}

interface MapStopProps {
  point: MapPoint;
  index: number;
  popup: boolean; // the popup shows
  placement: PopupPlacement | null; // null while it is measured, before it appears
  buttonRef: Ref<HTMLButtonElement>;
  popupRef: RefObject<HTMLButtonElement | null>;
  handlers: MapStopHandlers;
}

export function MapStop(props: MapStopProps) {
  const { point, index, popup, placement, buttonRef, popupRef, handlers } = props;
  const disc = point.approximate ? "map-marker map-marker--approximate" : "map-marker";
  // Where a one-finger touch on this stop began, while it lasts.
  const touch = useRef<{ x: number; y: number; fingers: number } | null>(null);

  // Decision: a tap on a stop or its popup stays out of the map. MapLibre counts every tap in its
  // container toward its double-tap zoom, so the second of the two taps a stop takes on touch
  // (one shows the popup, the next opens the details) zoomed the map instead and lost its click.
  // Only the end of a one-finger tap is kept back: a drag or a pinch that starts on a stop still
  // moves the map. A double-click on a stop does not zoom either.
  const onTouchStart = (event: TouchEvent) => {
    const first = event.touches[0];
    if (event.touches.length === 1 && first) {
      touch.current = { x: first.clientX, y: first.clientY, fingers: 1 };
    } else if (touch.current) {
      touch.current.fingers = Math.max(touch.current.fingers, event.touches.length);
    }
  };
  const onTouchEnd = (event: TouchEvent) => {
    const start = touch.current;
    touch.current = null;
    const end = event.changedTouches[0];
    // Another finger still down, or ever down with this one: a pinch, which is the map's.
    if (!start || !end || start.fingers > 1 || event.touches.length > 0) return;
    if (Math.hypot(end.clientX - start.x, end.clientY - start.y) < TAP_SLOP) {
      event.stopPropagation();
    }
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hover, focus leaving and taps only time the popup and keep taps from the map; the buttons inside are the controls.
    <div
      className="map-stop"
      data-open={popup ? "true" : undefined}
      onPointerEnter={(event) => handlers.onPointerEnter(index, event)}
      onPointerLeave={(event) => handlers.onPointerLeave(index, event)}
      onBlur={(event) => handlers.onBlur(index, event)}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
      onTouchCancel={() => {
        touch.current = null;
      }}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <button
        ref={buttonRef}
        type="button"
        className="map-stop-button"
        aria-label={stopLabel(point)}
        aria-haspopup="dialog"
        onPointerDown={handlers.onPointerDown}
        onFocus={(event) => handlers.onFocus(index, event)}
        onClick={() => handlers.onPress(index)}
        data-testid="map-stop"
      >
        <span className={disc} aria-hidden="true">
          {point.number}
        </span>
      </button>
      {popup ? (
        // Decision: the whole popup is one button, so the traveler can click or tap anywhere on
        // it, and its "Details" reads as a text button inside. It is not a tab stop: Enter on the
        // stop itself opens the same sheet, and the stop's name already says everything here.
        <button
          ref={popupRef}
          type="button"
          tabIndex={-1}
          className="map-popup"
          data-side={placement?.side ?? "above"}
          data-placed={placement ? "true" : undefined}
          style={{ "--shift": `${placement?.shift ?? 0}px` } as CSSProperties}
          aria-label={`Details for ${point.name}`}
          onClick={() => handlers.onDetails(index)}
          data-testid="map-popup"
        >
          <span className="map-popup-head">
            <span className={`${disc} map-popup-number`}>{point.number}</span>
            <span className="map-popup-name">{point.name}</span>
          </span>
          <span className="map-popup-when">
            <span className="map-popup-times t-time">
              <ClockText minutes={point.start} /> to <ClockText minutes={point.end} />
            </span>
            <span className="map-popup-role" data-role={point.role}>
              {roleWord(point.role)}
            </span>
          </span>
          <span className="map-popup-details">
            Details
            <ChevronIcon size={15} className="map-popup-chevron" />
          </span>
        </button>
      ) : null}
    </div>
  );
}
