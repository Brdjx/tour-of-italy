"use client";

import { DownIcon, RemoveIcon, SwapIcon, UpIcon } from "./icons";

// The four edits on a stop. Buttons that cannot act right now (move up on the first stop,
// remove on a day's only stop) stay focusable with aria-disabled, so keyboard focus is never
// dropped to the page when a stop moves to the top or bottom. Remove still reports why it did
// nothing (the reducer answers with a status message); the moves simply do nothing. Each
// accessible name starts with the visible word and adds the stop's name.

export interface StopActionHandlers {
  onSwap: () => void;
  onRemove: () => void;
  onMove: (direction: "up" | "down") => void;
}

interface StopActionsProps extends StopActionHandlers {
  name: string;
  canMoveUp: boolean;
  canMoveDown: boolean;
  canRemove: boolean;
}

const BUTTON =
  "inline-flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-md px-2.5 text-sm font-medium text-accent outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus aria-disabled:cursor-not-allowed aria-disabled:text-muted aria-disabled:opacity-60 aria-disabled:hover:bg-transparent";

export function StopActions(props: StopActionsProps) {
  const { name, canMoveUp, canMoveDown, canRemove } = props;
  const guard = (allowed: boolean, action: () => void) => () => {
    if (allowed) action();
  };
  return (
    <fieldset
      className="-ml-2.5 mt-1 flex min-w-0 flex-wrap items-center"
      data-testid="stop-actions"
    >
      <legend className="sr-only">Change {name}</legend>
      <button
        type="button"
        className={BUTTON}
        aria-label={`Swap ${name}`}
        onClick={props.onSwap}
        data-testid="swap-button"
      >
        <SwapIcon size={18} />
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
        <RemoveIcon size={18} />
        Remove
      </button>
      <button
        type="button"
        className={BUTTON}
        aria-label={`Move ${name} up`}
        aria-disabled={!canMoveUp}
        onClick={guard(canMoveUp, () => props.onMove("up"))}
        data-testid="move-up"
      >
        <UpIcon />
      </button>
      <button
        type="button"
        className={BUTTON}
        aria-label={`Move ${name} down`}
        aria-disabled={!canMoveDown}
        onClick={guard(canMoveDown, () => props.onMove("down"))}
        data-testid="move-down"
      >
        <DownIcon />
      </button>
    </fieldset>
  );
}
