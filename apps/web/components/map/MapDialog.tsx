"use client";

import {
  type CSSProperties,
  type KeyboardEvent,
  type RefObject,
  type SyntheticEvent,
  useId,
} from "react";
import { stopCountText } from "../../lib/mapPoints";
import { CloseIcon } from "../icons";
import type { MapDayOption } from "./types";

// The day's map full screen: a native <dialog> opened with showModal(), so the page behind is
// inert, focus stays inside and a stop's details sheet opened afterwards sits above it in the
// top layer. Its header clears the status bar and the notch and says which day it is, with the
// stop count and "Close map"; the day switcher floats at the foot, clear of the home indicator.
// The map itself is not drawn here: DayMapInner moves the page's map into `host` and grows it
// from its box on the page (the frame and inner elements carry that motion).

export interface MapDialogRefs {
  dialog: RefObject<HTMLDialogElement | null>;
  head: RefObject<HTMLElement | null>;
  heading: RefObject<HTMLHeadingElement | null>;
  stage: RefObject<HTMLDivElement | null>;
  frame: RefObject<HTMLDivElement | null>;
  inner: RefObject<HTMLDivElement | null>;
  host: RefObject<HTMLDivElement | null>;
  days: RefObject<HTMLFieldSetElement | null>;
}

interface MapDialogProps {
  id: string;
  title: string; // "Day 1, Fri 9 Oct, Rome"
  count: number; // stops on the map
  days: readonly MapDayOption[];
  active: number;
  onSelectDay: (index: number) => void;
  onRequestClose: () => void; // Close map, Escape or the browser's own close request
  onClosed: () => void; // the browser closed it without asking (see DayMapInner)
  refs: MapDialogRefs;
}

export function MapDialog(props: MapDialogProps) {
  const { id, title, count, days, active, onSelectDay, onRequestClose, onClosed, refs } = props;
  const titleId = useId();
  const radios = useId();

  // Escape from anywhere in the dialog. A stop's popup that used Escape marks it handled first.
  const onKeyDown = (event: KeyboardEvent<HTMLDialogElement>) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    onRequestClose();
  };

  // The browser's own close request (Escape where keydown did not reach, the Android back
  // gesture): keep the dialog open and let the map shrink back with its motion.
  const onCancel = (event: SyntheticEvent<HTMLDialogElement>) => {
    if (event.target !== event.currentTarget) return;
    event.preventDefault();
    onRequestClose();
  };

  const onClose = (event: SyntheticEvent<HTMLDialogElement>) => {
    if (event.target === event.currentTarget) onClosed();
  };

  return (
    <dialog
      ref={refs.dialog}
      id={id}
      className="map-dialog"
      aria-labelledby={titleId}
      aria-modal="true"
      onKeyDown={onKeyDown}
      onCancel={onCancel}
      onClose={onClose}
      data-testid="map-dialog"
    >
      <header ref={refs.head} className="map-dialog-head">
        <div className="map-dialog-heading">
          <h2
            id={titleId}
            ref={refs.heading}
            tabIndex={-1}
            className="map-dialog-title t-title outline-none"
            data-testid="map-dialog-title"
          >
            {title}
          </h2>
          <p className="map-dialog-meta">{stopCountText(count)}</p>
        </div>
        <button
          type="button"
          className="pill pill--line map-dialog-close"
          onClick={onRequestClose}
          aria-label="Close map"
          data-testid="map-close"
        >
          <CloseIcon size={20} />
          <span className="map-dialog-close-label">Close map</span>
        </button>
      </header>
      <div ref={refs.stage} className="map-dialog-stage">
        <div ref={refs.frame} className="map-dialog-frame">
          <div ref={refs.inner} className="map-dialog-inner">
            <div ref={refs.host} className="map-host" />
          </div>
        </div>
        {days.length > 1 ? (
          <fieldset ref={refs.days} className="map-dialog-days" data-testid="map-days">
            <legend className="sr-only">Trip days</legend>
            <div
              className="segmented"
              style={{ "--n": days.length, "--i": active } as CSSProperties}
            >
              {days.map((day) => (
                <label key={day.index} className="segment">
                  <input
                    type="radio"
                    name={radios}
                    value={day.index}
                    checked={day.index === active}
                    onChange={() => onSelectDay(day.index)}
                    className="sr-only"
                  />
                  <span aria-hidden="true">{day.label}</span>
                  <span className="sr-only">{day.name}</span>
                </label>
              ))}
            </div>
          </fieldset>
        ) : null}
      </div>
    </dialog>
  );
}
