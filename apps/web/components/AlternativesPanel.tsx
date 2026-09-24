"use client";

import { alternativesFor, type Itinerary, type PlannerContext } from "@italy/planner";
import { useMemo } from "react";
import { AlternativesSheet } from "./AlternativesSheet";

// Works out the swap options for one stop with the planner's alternativesFor (only places whose
// rebuilt day passes the scheduler and the validator) and shows them in the sheet.

/** Most alternatives offered for one stop. */
export const ALTERNATIVES_LIMIT = 6;

interface AlternativesPanelProps {
  itinerary: Itinerary;
  ctx: PlannerContext;
  target: { day: number; stop: number };
  onChoose: (placeId: string) => void;
  onClose: () => void;
}

export function AlternativesPanel({
  itinerary,
  ctx,
  target,
  onChoose,
  onClose,
}: AlternativesPanelProps) {
  const alternatives = useMemo(
    () => alternativesFor(itinerary, target.day, target.stop, ctx, ALTERNATIVES_LIMIT),
    [itinerary, target.day, target.stop, ctx],
  );
  const day = itinerary.days[target.day];
  const stop = day?.stops[target.stop];
  const name = (stop && ctx.placesById.get(stop.placeId)?.name) ?? "this stop";
  return (
    <AlternativesSheet
      stopName={name}
      date={day?.date ?? ""}
      alternatives={alternatives}
      onChoose={onChoose}
      onClose={onClose}
      returnFocus={() =>
        document.querySelector<HTMLElement>(
          `#stop-${target.day}-${target.stop} [data-testid="swap-button"]`,
        )
      }
    />
  );
}
