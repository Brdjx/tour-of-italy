"use client";

import { type DaySelection, type PlannerContext, planRoute, withDay } from "@italy/planner";
import { useCallback, useEffect, useRef, useState } from "react";
import { type DayCallDeps, type DayReply, requestDay, tripSelection } from "./dayCity";
import {
  ideasRun,
  jobBody,
  planningText,
  type ReplannedResult,
  type ReplanRun,
  replanMessage,
  resolveJob,
  routeRun,
  sameRoute,
  tripRoute,
} from "./dayRoute";
import type { ItineraryAction, ItineraryState } from "./itineraryReducer";
import type { FallbackCause } from "./planRequest";
import { SLOW_PLAN_MS } from "./usePlanTrip";

// The route sheet and the days it plans, as page state. The city on a day's line opens the sheet
// on that day's list of cities, over the route view of every day; choosing a city sets it in the
// route being set (the draft) and goes back to the route view, which says what the route does.
// Its action plans the days the route names one request at a time, in day order, each with the
// route and the trip as planned so far (decision 16), while those days show their skeletons and
// the rest of the trip stays readable. The days go in at the end as one edit. New ideas for a day
// runs the same way as a run of one day. A new plan, or none, gives up a run still on its way.

/** The line under a day that is still planning after SLOW_PLAN_MS. */
export const SLOW_DAY_TEXT =
  "Still working. If the AI planner takes too long, the day is planned with rules.";

/** The two levels of the route sheet: every day, or one day's cities. */
export type RouteLevel = "route" | "day";

export interface RouteSheetState {
  open: boolean;
  level: RouteLevel;
  day: number; // the day whose cities are shown, or were last (0-based)
  draft: string[]; // the route being set, a base id a day
  moved: boolean; // the level changed since the sheet opened (it slides instead of dropping in)
  after: number | null; // the day whose heading takes focus as the sheet closes on a run
}

/** A run on its way: which day it is planning, and the days planned so far. */
export interface RoutePending {
  planId: number; // the plan it belongs to
  run: ReplanRun;
  step: number; // the job being planned
  done: ReplannedResult[];
  slow: boolean; // the day being planned is still on its way after SLOW_PLAN_MS
}

interface DayRouteOptions {
  plan: ItineraryState;
  ctx: PlannerContext | null;
  post?: DayCallDeps["post"]; // injected in tests
  announce: (text: string, edit?: boolean) => void;
  // The edit path (usePlanEdits), so the result shows in the toast with Undo.
  apply: (action: Extract<ItineraryAction, { type: "replan" }>) => void;
  onDayPlanned: (day: number) => void; // a day of the run arrived
  showDay: (day: number) => void; // select a day's tab
}

const CLOSED: RouteSheetState = {
  open: false,
  level: "day",
  day: 0,
  draft: [],
  moved: false,
  after: null,
};

export function useDayRoute(options: DayRouteOptions) {
  const [sheet, setSheet] = useState<RouteSheetState>(CLOSED);
  const [pending, setPending] = useState<RoutePending | null>(null);
  // What the sheet says in its own live region; the page's region is inert behind it.
  const [said, setSaid] = useState<{ text: string | null; serial: number }>({
    text: null,
    serial: 0,
  });
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

  const say = (text: string) => setSaid((current) => ({ text, serial: current.serial + 1 }));

  /** Opens the sheet on day `day`'s cities, with the route as the trip has it. */
  const open = (day: number) => {
    if (pending || !itinerary?.days[day]) return;
    setSheet({
      open: true,
      level: "day",
      day,
      draft: tripRoute(itinerary),
      moved: false,
      after: null,
    });
    setSaid((current) => ({ text: null, serial: current.serial }));
  };

  const close = () => setSheet((current) => ({ ...current, open: false }));

  const openDay = (day: number) =>
    setSheet((current) => ({ ...current, level: "day", day, moved: true }));

  const back = () => setSheet((current) => ({ ...current, level: "route", moved: true }));

  /** Sets the day's city in the route being set, and goes back to the route. */
  const choose = (anchorId: string) => {
    const name = latest.current.ctx?.anchorById.get(anchorId)?.name ?? anchorId;
    say(`Day ${sheet.day + 1} set to ${name}.`);
    setSheet((current) => ({
      ...current,
      level: "route",
      moved: true,
      draft: current.draft.map((id, index) => (index === current.day ? anchorId : id)),
    }));
  };

  /** Back to the trip's own cities. */
  const reset = () => {
    const current = latest.current.plan.itinerary;
    if (!current) return;
    say("Route reset.");
    setSheet((state) => ({ ...state, draft: tripRoute(current) }));
  };

  /** Plans the route being set. */
  const confirm = () => {
    const { plan, ctx } = latest.current;
    const current = plan.itinerary;
    if (!current || !ctx || sameRoute(current, sheet.draft)) return;
    const route = planRoute(current.request, tripSelection(current), sheet.draft, ctx);
    if (!route.allowed) return;
    start(routeRun(current, route, ctx));
  };

  /** New ideas for the sheet's day, in its own city. */
  const ideas = () => {
    const { plan, ctx } = latest.current;
    const current = plan.itinerary;
    if (!current || !ctx) return;
    start(ideasRun(current, sheet.day, ctx));
  };

  const start = (run: ReplanRun) => {
    const { plan, ctx } = latest.current;
    const current = plan.itinerary;
    const first = run.jobs[0];
    if (!current || !ctx || !first || controller.current) return;
    const call = new AbortController();
    controller.current = call;
    setSheet((state) => ({ ...state, open: false, after: first.day }));
    latest.current.showDay(first.day);
    setPending({ planId: plan.planId, run, step: 0, done: [], slow: false });
    void runJobs(run, current, ctx, call);
  };

  // Decision: one request at a time, in day order, each carrying the route and the days planned
  // before it, so the server shortlists each day without the places the earlier days took and
  // one model call fits the plan deadline (decision 15). After a call fails, the rest of the run
  // is planned here without asking again: the next call would likely fail the same way, and the
  // traveler would wait up to the deadline for each day.
  const finish = () => {
    controller.current = null;
    clearTimeout(slowTimer.current);
    setPending(null);
  };

  const runJobs = async (
    run: ReplanRun,
    current: NonNullable<ItineraryState["itinerary"]>,
    ctx: PlannerContext,
    call: AbortController,
  ) => {
    const deterministic =
      new URLSearchParams(window.location.search).get("mode") === "deterministic";
    const post = latest.current.post;
    let working: DaySelection[] = run.start.map((day) => ({ ...day, placeIds: [...day.placeIds] }));
    const done: ReplannedResult[] = [];
    let failed: FallbackCause | null = null;
    for (const [step, job] of run.jobs.entries()) {
      setPending((now) => (now ? { ...now, step, slow: false } : now));
      latest.current.announce(`${planningText(run, step)}.`);
      clearTimeout(slowTimer.current);
      slowTimer.current = setTimeout(() => {
        setPending((now) => (now ? { ...now, slow: true } : now));
        latest.current.announce(SLOW_DAY_TEXT);
      }, SLOW_PLAN_MS);
      let reply: DayReply;
      if (failed) {
        reply = { kind: "failed", cause: failed };
      } else {
        try {
          const body = jobBody(current.request, working, job, run.route);
          reply = await requestDay(body, post ? { post } : {}, {
            signal: call.signal,
            deterministic,
          });
        } catch {
          return; // cancelled: a new plan or Start a new trip took its place, and stop() ran
        }
      }
      if (call.signal.aborted) return;
      clearTimeout(slowTimer.current);
      if (reply.kind === "failed") failed = reply.cause;
      const resolved = resolveJob(current, working, job, reply, ctx);
      if (resolved.kind === "refused") {
        finish();
        latest.current.announce(`${resolved.reason} Your trip was left as it was.`, true);
        return;
      }
      const placeIds = resolved.dayPlan.stops.map((stop) => stop.placeId);
      working = withDay(working, job.day, { anchorId: job.anchorId, placeIds });
      done.push({ day: job.day, dayPlan: resolved.dayPlan, made: resolved.made });
      setPending((now) => (now ? { ...now, done: [...done] } : now));
      latest.current.onDayPlanned(job.day);
    }
    finish();
    const message = replanMessage(run, done);
    latest.current.apply({ type: "replan", kind: run.kind, basis: run.basis, days: done, message });
  };

  return { sheet, pending, said, open, close, openDay, back, choose, reset, confirm, ideas };
}

export type DayRoute = ReturnType<typeof useDayRoute>;
