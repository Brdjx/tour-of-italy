"use client";

import type { ReactNode } from "react";
import { DownIcon, RemoveIcon, SwapIcon, UpIcon } from "./icons";

// The four edits on a stop: Details, Swap and Remove as quiet pills under the stop, and the two
// moves in the time column (StopMoves). Buttons that cannot act right now (move up on the first
// stop, remove on a day's only stop) stay focusable with aria-disabled, so keyboard focus is
// never dropped to the page when a stop moves to the top or bottom. Remove still reports why it did nothing (the reducer answers with a status message);
// the moves simply do nothing. Each accessible name starts with the visible word and adds the
// stop's name.

export interface StopActionHandlers {
  onSwap: () => void;
  onRemove: () => void;
  onMove: (direction: "up" | "down") => void;
}

interface StopActionsProps {
  name: string;
  canRemove: boolean;
  onSwap: () => void;
  onRemove: () => void;
  details?: ReactNode; // the stop's Details toggle, first in the row
}

// Pills: text actions with a label (timetable.css).
const BUTTON = "stop-action";
const ROUND = "stop-action stop-action--round";

/** Details, Swap and Remove, under the stop. */
export function StopActions(props: StopActionsProps) {
  const { name, canRemove } = props;
  return (
    <fieldset className="stop-actions" data-testid="stop-actions">
      <legend className="sr-only">Change {name}</legend>
      {props.details}
      <button
        type="button"
        className={BUTTON}
        aria-label={`Swap ${name}`}
        onClick={props.onSwap}
        data-testid="swap-button"
      >
        <SwapIcon size={17} />
        Swap
      </button>
      <button
        type="button"
        className={BUTTON}
        aria-label={`Remove ${name}`}
        aria-disabled={!canRemove}
        onClick={props.onRemove}
        data-testid="remove-button"
      >
        <RemoveIcon size={17} />
        Remove
      </button>
    </fieldset>
  );
}

interface StopMovesProps {
  name: string;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMove: (direction: "up" | "down") => void;
}

/**
 * Move up and Move down, stacked in the time column under the stop's times, like the reorder
 * handles on a board: they sit next to the times they change.
 */
export function StopMoves(props: StopMovesProps) {
  const { name, canMoveUp, canMoveDown } = props;
  const guard = (allowed: boolean, direction: "up" | "down") => () => {
    if (allowed) props.onMove(direction);
  };
  return (
    <fieldset className="stop-moves" data-testid="stop-moves">
      <legend className="sr-only">Reorder {name}</legend>
      <button
        type="button"
        className={ROUND}
        aria-label={`Move ${name} up`}
        aria-disabled={!canMoveUp}
        onClick={guard(canMoveUp, "up")}
        data-testid="move-up"
      >
        <UpIcon />
      </button>
      <button
        type="button"
        className={ROUND}
        aria-label={`Move ${name} down`}
        aria-disabled={!canMoveDown}
        onClick={guard(canMoveDown, "down")}
        data-testid="move-down"
      >
        <DownIcon />
      </button>
    </fieldset>
  );
}
