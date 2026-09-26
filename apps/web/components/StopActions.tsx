"use client";

import type { ReactNode } from "react";
import { DownIcon, RemoveIcon, SwapIcon, UpIcon } from "./icons";

// The edits on a stop, on one line under it: Details, Swap and Remove, then Move up and Move down
// as round icon pills at the end of the line. On phones Swap and Remove are round icon pills too,
// and their words come back from 640 px (timetable.css), so the whole set fits one line at
// 390 px. Buttons that cannot act right now (move up on the first stop, remove on a day's only
// stop) stay focusable with aria-disabled, so keyboard focus is never dropped to the page when a
// stop moves to the top or bottom. Remove still reports why it did nothing (the reducer answers
// with a status message); the moves simply do nothing. Each accessible name starts with the
// action's word and adds the stop's name, so an icon-only pill still says what it does. While days
// of a route are planned (`locked`), every edit waits: the pills dim in place and do nothing, and
// Details still opens.

export interface StopActionHandlers {
  onSwap: () => void;
  onRemove: () => void;
  onMove: (direction: "up" | "down") => void;
}

interface StopActionsProps extends StopActionHandlers {
  name: string;
  canRemove: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  locked?: boolean; // editing waits while days are planned again
  details?: ReactNode; // the stop's Details toggle, first in the line
}

// Pills: one whose label hides on phones, and a round icon pill (timetable.css). The Details
// pill keeps its word at every width; StopRow builds it.
const COMPACT = "stop-action stop-action--compact";
const ROUND = "stop-action stop-action--round";

/** Details, Swap, Remove, Move up and Move down, on one line under the stop. */
export function StopActions(props: StopActionsProps) {
  const { name, canRemove } = props;
  const locked = props.locked === true;
  return (
    <div className="stop-controls">
      <fieldset className="stop-actions" data-testid="stop-actions">
        <legend className="sr-only">Change {name}</legend>
        {props.details}
        <button
          type="button"
          className={COMPACT}
          aria-label={`Swap ${name}`}
          aria-disabled={locked || undefined}
          onClick={locked ? undefined : props.onSwap}
          data-testid="swap-button"
        >
          <SwapIcon size={17} />
          <span className="stop-action-label">Swap</span>
        </button>
        <button
          type="button"
          className={COMPACT}
          aria-label={`Remove ${name}`}
          aria-disabled={locked || !canRemove}
          onClick={locked ? undefined : props.onRemove}
          data-testid="remove-button"
        >
          <RemoveIcon size={17} />
          <span className="stop-action-label">Remove</span>
        </button>
      </fieldset>
      <StopMoves
        name={name}
        canMoveUp={props.canMoveUp && !locked}
        canMoveDown={props.canMoveDown && !locked}
        onMove={props.onMove}
      />
    </div>
  );
}

interface StopMovesProps {
  name: string;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMove: (direction: "up" | "down") => void;
}

/** Move up and Move down, the last two pills on the stop's line, grouped as the reorder pair. */
// Decision: pushed to the end of the line, where iOS lists keep their reorder handles, so on
// every row the pair sits in the same place at the right edge of the board and the eye finds it
// without reading the row.
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
