"use client";

import type { PlannerContext } from "@italy/planner";
import { useCallback, useEffect, useRef, useState } from "react";
import { type DayCallDeps, dayAsk, dayRequestBody, requestDay, tripKey } from "./dayCity";
import type { ItineraryAction, ItineraryState } from "./itineraryReducer";
import { SLOW_PLAN_MS } from "./usePlanTrip";

// The Change city sheet and the day it plans, as page state. The sheet opens on a day; choosing
// a city (or new ideas at the day's own) closes it and asks POST /api/plan/day, while that day's
// board shows its skeleton and the rest of the trip stays in use. The answer goes to the reducer
// as one edit, which takes it or plans the day here (lib/dayCity.ts, resolveDay). One day plans
// at a time; a new plan, or none, gives up a day still on its way.

/** The line under a day that is still planning after SLOW_PLAN_MS. */
export const SLOW_DAY_TEXT =
  "Still working. If the AI planner takes too long, the day is planned with rules.";

/** The day being planned again. */
export interface DayPending {
  day: number; // 0-based
  anchorId: string;
  name: string; // the city's name
  ideas: boolean; // new ideas at the day's own city
  slow: boolean; // still on its way after SLOW_PLAN_MS
  planId: number; // the plan it belongs to
}

interface DayCityOptions {
  plan: ItineraryState;
  ctx: PlannerContext | null;
  post?: DayCallDeps["post"]; // injected in tests
  announce: (text: string) => void;
  // The edit path (usePlanEdits), so the result shows in the toast with Undo.
  apply: (action: Extract<ItineraryAction, { type: "day" }>) => void;
  onPlanned: (day: number) => void;
}

/** "Planning day 2 in Florence" or "Planning new ideas for day 2". */
export function planningText(pending: Pick<DayPending, "day" | "name" | "ideas">): string {
  const day = pending.day + 1;
  return pending.ideas
    ? `Planning new ideas for day ${day}`
    : `Planning day ${day} in ${pending.name}`;
}

export function useDayCity(options: DayCityOptions) {
  const [sheet, setSheet] = useState<{ open: boolean; day: number | null }>({
    open: false,
    day: null,
  });
  const [pending, setPending] = useState<DayPending | null>(null);
  const controller = useRef<AbortController | null>(null);
  const slowTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef(options);
  latest.current = options;

  const stop = useCallback(() => {
    controller.current?.abort();
    controller.current = null;
    clearTimeout(slowTimer.current);
    setPending(null);
  }, []);

  useEffect(() => () => stop(), [stop]);

  // A new plan (Plan my trip in the Edit trip sheet), or no plan at all (Start a new trip).
  const { planId, itinerary } = options.plan;
  useEffect(() => {
    if (pending && (itinerary === null || planId !== pending.planId)) stop();
  }, [pending, planId, itinerary, stop]);

  const open = (day: number) => {
    if (pending || !itinerary?.days[day]) return;
    setSheet({ open: true, day });
  };

  const close = () => setSheet((current) => ({ ...current, open: false }));

  const choose = (anchorId: string) => {
    const day = sheet.day;
    const { plan, ctx, post, announce } = latest.current;
    close();
    const current = plan.itinerary;
    if (day === null || !current?.days[day] || !ctx || controller.current) return;
    const ask = dayAsk(current, day, anchorId);
    const basis = tripKey(current);
    const call = new AbortController();
    controller.current = call;
    const next: DayPending = {
      day,
      anchorId,
      name: ctx.anchorById.get(anchorId)?.name ?? anchorId,
      ideas: current.days[day]?.anchorId === anchorId,
      slow: false,
      planId: plan.planId,
    };
    setPending(next);
    announce(`${planningText(next)}.`);
    slowTimer.current = setTimeout(() => {
      setPending((now) => (now ? { ...now, slow: true } : now));
      announce(SLOW_DAY_TEXT);
    }, SLOW_PLAN_MS);
    const deterministic =
      new URLSearchParams(window.location.search).get("mode") === "deterministic";
    void requestDay(dayRequestBody(current, ask), post ? { post } : {}, {
      signal: call.signal,
      deterministic,
    }).then(
      (reply) => {
        if (call.signal.aborted) return;
        controller.current = null;
        clearTimeout(slowTimer.current);
        setPending(null);
        latest.current.apply({ type: "day", ask, reply, basis });
        latest.current.onPlanned(day);
      },
      () => {
        // Cancelled: a new plan or Start a new trip took its place, and stop() cleared it.
      },
    );
  };

  return { sheet, pending, open, close, choose };
}

export type DayCity = ReturnType<typeof useDayCity>;
