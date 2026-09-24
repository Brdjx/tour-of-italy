"use client";

// Decision: first import, before anything that builds a Zod schema (see lib/zodSetup.ts).
import "../lib/zodSetup";
import { useCallback, useEffect, useRef, useState } from "react";
import { useEditFocus } from "../lib/editFocus";
import { undoLabel } from "../lib/itineraryReducer";
import { restoredNote } from "../lib/lastPlan";
import type { PlanDeps } from "../lib/planRequest";
import { defaultFormValues, valuesFromRequest } from "../lib/tripForm";
import { useItinerary } from "../lib/useItinerary";
import { type RestoredPlan, useLastPlan } from "../lib/useLastPlan";
import { usePlanTrip } from "../lib/usePlanTrip";
import { useSharedLinkOnLoad } from "../lib/useSharedLink";
import { type TripDataLoader, useTripData } from "../lib/useTripData";
import { AlternativesPanel } from "./AlternativesPanel";
import { DataNotesPanel } from "./DataNotesPanel";
import { prefetchMap } from "./DayMap";
import { ErrorState, Notice } from "./ErrorState";
import { FormPane } from "./FormPane";
import { OfflineBanner } from "./OfflineBanner";
import { EmptyPlan, PlanningState } from "./PlanStates";
import { PlanView } from "./PlanView";
import { LiveRegion, Toast } from "./StatusRegion";
import { UpdatePrompt } from "./UpdatePrompt";

// The whole page: loads the data, owns the plan state, and lays out the form, the plan and the
// data notes for phones, tablets and desktops (see app/styles/layout.css for the layouts).

export interface PlannerAppProps {
  loader?: TripDataLoader; // injected in tests
  post?: PlanDeps["post"]; // injected in tests
  today?: () => Date;
}

export function PlannerApp({ loader, post, today = () => new Date() }: PlannerAppProps) {
  const { state: dataState, retry: retryData } = useTripData(loader);
  const data = dataState.status === "ready" ? dataState.data : null;
  const ctx = data?.ctx ?? null;
  const [plan, dispatch] = useItinerary(ctx);
  const [form, setForm] = useState(() => ({ key: 0, values: defaultFormValues(today()) }));
  const [formOpen, setFormOpen] = useState(false);
  const [activeDay, setActiveDay] = useState(0);
  const [animateDay, setAnimateDay] = useState(-1);
  const [notice, setNotice] = useState<string | null>(null);
  const [swap, setSwap] = useState<{ day: number; stop: number } | null>(null);
  const [status, setStatus] = useState({ text: null as string | null, serial: 0, edit: false });
  const heading = useRef<HTMLHeadingElement>(null);
  const formHeading = useRef<HTMLHeadingElement>(null);
  const formToggled = useRef(false);
  const editPending = useRef(false);
  const expectFocus = useEditFocus(plan, heading);

  const announce = useCallback((text: string, edit = false) => {
    setStatus((current) => ({ text, serial: current.serial + 1, edit }));
  }, []);

  const { phase, planTrip, retry } = usePlanTrip({
    ctx,
    post,
    dispatch,
    announce,
    onPlanned: () => {
      setActiveDay(0);
      setAnimateDay(0);
      setFormOpen(false);
      setNotice(null);
    },
  });

  // Every reducer result carries a status sentence; announce it once per state change.
  useEffect(() => {
    if (!plan.message) return;
    announce(plan.message, editPending.current);
    editPending.current = false;
  }, [plan, announce]);

  // A failed plan brings its message into view: on phones the plan pane sits below the form.
  useEffect(() => {
    if (phase.kind === "error")
      document.getElementById("plan-error")?.scrollIntoView?.({ block: "nearest" });
  }, [phase]);

  // A new plan moves focus to the day heading, so keyboard and screen reader users land on it.
  useEffect(() => {
    if (plan.planId > 0) heading.current?.focus({ preventScroll: false });
  }, [plan.planId]);

  // Opening the form over a plan (phones and tablets) moves focus to its heading at the top;
  // closing it with "Back to plan" returns focus to "Edit trip".
  useEffect(() => {
    if (!formToggled.current) return;
    formToggled.current = false;
    if (formOpen) formHeading.current?.focus();
    else document.querySelector<HTMLElement>('[data-testid="edit-trip-button"]')?.focus();
  }, [formOpen]);

  // Decision: fetch the map's code while the traveler fills in the form, so a dropped request
  // at the moment of planning, or going offline before the worker cached it, cannot cost the map.
  useEffect(() => {
    if (ctx) return prefetchMap();
  }, [ctx]);

  const restore = ({ itinerary, origin, cause, flagged }: RestoredPlan) => {
    dispatch({ type: "plan", itinerary, origin, cause, message: "Showing your last plan." });
    setForm((current) => ({ key: current.key + 1, values: valuesFromRequest(itinerary.request) }));
    setNotice(restoredNote(flagged));
  };
  useLastPlan(ctx, plan, restore, { now: today });

  useSharedLinkOnLoad(ctx, (result) => {
    if (result.status === "plan") {
      dispatch({
        type: "plan",
        itinerary: result.itinerary,
        origin: "shared",
        message: result.note,
      });
      setAnimateDay(0);
    }
    const request =
      result.status === "plan"
        ? result.itinerary.request
        : result.status === "request"
          ? result.request
          : null;
    if (request) {
      setForm((current) => ({ key: current.key + 1, values: valuesFromRequest(request) }));
    }
    setNotice(result.note);
  });

  const edit = (action: Parameters<typeof dispatch>[0]) => {
    editPending.current = true;
    setAnimateDay(-1);
    dispatch(action);
  };

  const toggleForm = (open: boolean) => {
    formToggled.current = true;
    setFormOpen(open);
  };

  const undo = () => {
    // Show the day the undone edit was on, so the traveler sees what came back.
    const last = plan.history.at(-1);
    if (last) setActiveDay(last.at.day);
    expectFocus({ type: "undo", planId: plan.planId });
    edit({ type: "undo" });
  };

  const hasPlan = plan.itinerary !== null && ctx !== null;
  // Decision: a note shows where the traveler looks next: above the form while there is no
  // plan (a damaged link, on a phone, would otherwise sit two screens down), else on the plan.
  const noticeBanner = notice ? (
    <Notice message={notice} onDismiss={() => setNotice(null)} testId="share-notice" />
  ) : null;
  return (
    <div
      className="app"
      data-has-plan={hasPlan ? "true" : "false"}
      data-form-open={formOpen ? "true" : "false"}
    >
      <div className="status-scrim" aria-hidden="true" />
      <a className="skip-link" href="#plan">
        Skip to your plan
      </a>
      <header className="app-header">
        <h1 className="text-xl font-semibold tracking-tight text-fg">3 Days in Italy</h1>
      </header>
      <OfflineBanner canPlan={ctx !== null} />
      <UpdatePrompt />
      <div className="app-body">
        <FormPane
          dataState={dataState}
          onRetryData={retryData}
          form={form}
          planning={phase.kind === "planning"}
          onSubmit={planTrip}
          reopened={hasPlan && formOpen}
          onBack={() => toggleForm(false)}
          headingRef={formHeading}
          notice={hasPlan ? null : noticeBanner}
        />
        <main id="plan" className="plan-pane" tabIndex={-1} aria-busy={phase.kind === "planning"}>
          {hasPlan ? noticeBanner : null}
          {phase.kind === "error" ? (
            <ErrorState id="plan-error" message={phase.message} onRetry={retry} />
          ) : null}
          {hasPlan && ctx ? (
            <PlanView
              plan={plan}
              ctx={ctx}
              activeDay={activeDay}
              animateDay={animateDay}
              formOpen={formOpen}
              headingRef={heading}
              onSelectDay={(day) => {
                setActiveDay(day);
                setAnimateDay(-1);
              }}
              onToggleForm={() => toggleForm(!formOpen)}
              onUndo={undo}
              onSwap={(day, stop) => setSwap({ day, stop })}
              onRemove={(day, stop) => {
                const placeId = plan.itinerary?.days[day]?.stops[stop]?.placeId ?? "";
                expectFocus({ type: "remove", planId: plan.planId, day, stop, placeId });
                edit({ type: "remove", day, stop });
              }}
              onMove={(day, stop, direction) => {
                expectFocus({ type: "move", planId: plan.planId });
                edit({ type: "move", day, stop, direction });
              }}
              onStatus={(text) => announce(text)}
            />
          ) : phase.kind === "planning" ? (
            <PlanningState />
          ) : (
            <EmptyPlan />
          )}
        </main>
        {data ? (
          <section className="notes-pane" aria-label="About this data">
            <DataNotesPanel summary={data.summary} />
          </section>
        ) : null}
      </div>
      <LiveRegion message={status.text} serial={status.serial} />
      <Toast
        message={status.edit && !formOpen ? status.text : null}
        serial={status.serial}
        undoLabel={undoLabel(plan)}
        onUndo={undo}
      />
      {swap && plan.itinerary && ctx ? (
        <AlternativesPanel
          itinerary={plan.itinerary}
          ctx={ctx}
          target={swap}
          onChoose={(placeId) => {
            edit({ type: "swap", day: swap.day, stop: swap.stop, placeId });
            setSwap(null);
          }}
          onClose={() => setSwap(null)}
        />
      ) : null}
    </div>
  );
}
