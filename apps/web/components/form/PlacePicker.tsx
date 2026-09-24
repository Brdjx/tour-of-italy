"use client";

import { type KeyboardEvent, useId, useMemo, useState } from "react";
import type { PlaceOption } from "../../lib/tripOptions";
import { CloseIcon } from "../icons";

// A searchable place picker (ARIA 1.2 combobox with a listbox popup) for must-see and skip
// lists. Arrow keys move through matches, Enter picks, Escape closes the list and then clears
// the text. Picked places show as removable tokens above the input. At the limit the input
// stays focusable but read-only, so picking the last allowed place never drops focus.

/** Most matches listed at once. */
export const MAX_MATCHES = 8;

interface PlacePickerProps {
  label: string;
  hint: string;
  places: readonly PlaceOption[];
  selected: readonly string[];
  blocked: readonly string[]; // picked in the other list, so not offered here
  max: number;
  onChange: (ids: string[]) => void;
  error?: string;
  testId?: string;
}

/** Lowercase text without accents, so "sapienza" finds "Sapienza" and "cafe" finds "Caffè". */
export function foldText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

export function matchPlaces(
  places: readonly PlaceOption[],
  query: string,
  hidden: ReadonlySet<string>,
): PlaceOption[] {
  const needle = foldText(query.trim());
  if (needle === "") return [];
  const found: PlaceOption[] = [];
  for (const place of places) {
    if (hidden.has(place.id)) continue;
    if (foldText(place.name).includes(needle) || foldText(place.city).includes(needle)) {
      found.push(place);
      if (found.length === MAX_MATCHES) break;
    }
  }
  return found;
}

export function PlacePicker(props: PlacePickerProps) {
  const { label, hint, places, selected, blocked, max, onChange, error, testId } = props;
  const id = useId();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const full = selected.length >= max;
  const hidden = useMemo(() => new Set([...selected, ...blocked]), [selected, blocked]);
  const matches = useMemo(() => matchPlaces(places, query, hidden), [places, query, hidden]);
  const byId = useMemo(() => new Map(places.map((place) => [place.id, place])), [places]);
  const showList = open && !full && matches.length > 0;

  const pick = (place: PlaceOption) => {
    onChange([...selected, place.id]);
    setQuery("");
    setOpen(false);
    setActive(-1);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const count = matches.length;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      if (count === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((current) => (current + step + count) % count);
    } else if (event.key === "Enter" && showList) {
      event.preventDefault();
      const choice = matches[active] ?? matches[0];
      if (choice) pick(choice);
    } else if (event.key === "Escape") {
      event.preventDefault();
      if (open) setOpen(false);
      else setQuery("");
      setActive(-1);
    }
  };

  const describedBy = [`${id}-hint`, error ? `${id}-error` : null].filter(Boolean).join(" ");
  return (
    <div className="field" data-testid={testId}>
      <label htmlFor={`${id}-input`} className="field-label">
        {label}
      </label>
      {selected.length > 0 ? (
        <ul className="mb-2 flex flex-wrap gap-2" aria-label={`${label}, picked`}>
          {selected.map((placeId) => {
            const name = byId.get(placeId)?.name ?? placeId;
            return (
              <li key={placeId}>
                <button
                  type="button"
                  className="token"
                  onClick={() => onChange(selected.filter((value) => value !== placeId))}
                  aria-label={`Remove ${name} from ${label.toLowerCase()}`}
                >
                  <span>{name}</span>
                  <CloseIcon size={16} />
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
      <div className="relative">
        <input
          id={`${id}-input`}
          type="text"
          role="combobox"
          autoComplete="off"
          aria-autocomplete="list"
          aria-expanded={showList}
          aria-controls={`${id}-list`}
          aria-activedescendant={showList && active >= 0 ? `${id}-option-${active}` : undefined}
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
          className="text-input"
          placeholder={full ? "Remove one to add another" : "Search by name or city"}
          // Decision: read-only with aria-disabled, not disabled. A disabled input loses focus
          // the moment the last allowed place is picked, and focus falls to the page.
          readOnly={full}
          aria-disabled={full || undefined}
          value={full ? "" : query}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
            setActive(-1);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={onKeyDown}
        />
        <div
          id={`${id}-list`}
          role="listbox"
          aria-label={label}
          className="listbox"
          hidden={!showList}
        >
          {matches.map((place, index) => (
            // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard selection is handled on the combobox input (Arrow keys and Enter), per the ARIA combobox pattern.
            <div
              key={place.id}
              id={`${id}-option-${index}`}
              role="option"
              tabIndex={-1}
              aria-selected={index === active}
              className="option"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => pick(place)}
            >
              <span className="block text-base text-fg">{place.name}</span>
              <span className="block text-sm text-muted">{place.city}</span>
            </div>
          ))}
        </div>
      </div>
      <p id={`${id}-hint`} className="field-hint">
        {open && query.trim() !== "" && matches.length === 0 && !full ? "No places match. " : ""}
        {full ? "You picked the most allowed. Remove one to add another. " : ""}
        {hint}
      </p>
      {error ? (
        <p id={`${id}-error`} className="field-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
