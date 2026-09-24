"use client";

// Decision: first import, before anything that builds a Zod schema (see lib/zodSetup.ts).
import "../lib/zodSetup";
import type { TripRequest } from "@italy/planner";
import { useCallback, useEffect, useRef, useState } from "react";
import { useEditFocus } from "../lib/editFocus";
import { undoLabel } from "../lib/itineraryReducer";
import { restoredNote } from "../lib/lastPlan";
import type { PlanDeps } from "../lib/planRequest";
import { defaultFormValues, valuesFromRequest } from "../lib/tripForm";
import { useItinerary } from "../lib/useItinerary";
import { type RestoredPlan, useLastPlan } from "../lib/useLastPlan";
import { usePageFocus } from "../lib/usePageFocus";
import { usePlanEdits } from "../lib/usePlanEdits";
import { usePlanExpected } from "../lib/usePlanExpected";
import { usePlanTrip } from "../lib/usePlanTrip";
import { useSharedLinkOnLoad } from "../lib/useSharedLink";
import { type TripDataLoader, useTripData } from "../lib/useTripData";
import { AlternativesPanel } from "./AlternativesPanel";
import { prefetchMap } from "./DayMap";
import { ErrorState, Notice } from "./ErrorState";
import { Highlights } from "./Highlights";
import { OfflineBanner } from "./OfflineBanner";
import { AppFooter, AppHeader, type PlanContent, PlanPane } from "./PlanPane";
import { PlanView } from "./PlanView";
import { LiveRegion, Toast } from "./StatusRegion";
import { type PageView, TripPane } from "./TripPane";
import { UpdatePrompt } from "./UpdatePrompt";

// The whole page. Before any plan it is one calm column: the start date, the pace, "More
// options" and "Plan my trip", which all work before the data arrives. From the moment a plan
// is asked for, the form folds into a one-line trip summary and the plan area shows the plan's
// skeleton, then the plan (see app/styles/layout.css for the layouts).

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
  const [status, setStatus] = useState({ text: null as string | null, serial: 0, edit: false });
  const heading = useRef<HTMLHeadingElement>(null);
  const formHeading = useRef<HTMLHeadingElement>(null);
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

  const edits = usePlanEdits({
    plan,
    dispatch,
    announce,
    expectFocus,
    showDay: setActiveDay,
    onEdit: () => setAnimateDay(-1),
  });

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

  // After the two hooks above, so a restored or shared plan replaces the skeleton in one step.
  const expected = usePlanExpected(dataState.status !== "loading");
  const setFocusNext = usePageFocus({
    phase,
    planId: plan.planId,
    dayHeading: heading,
    formHeading,
  });

  // A plan that arrived before the places is checked in this browser once they load.
  useEffect(() => {
    if (ctx) dispatch({ type: "check" });
  }, [ctx, dispatch]);

  // Decision: fetch the map's code while the traveler fills in the form, so a dropped request
  // at the moment of planning, or going offline before the worker cached it, cannot cost the map.
  useEffect(() => {
    if (ctx) return prefetchMap();
  }, [ctx]);

  const openForm = (open: boolean) => {
    setFormOpen(open);
    setFocusNext(open ? "form" : "edit");
  };

  const submit = (request: TripRequest) => {
    setFormOpen(false);
    setFocusNext("plan");
    void planTrip(request);
  };

  const planning = phase.kind === "planning";
  const hasPlan = plan.itinerary !== null && ctx !== null;
  const waiting = plan.itinerary !== null && ctx === null; // a plan came before the places
  const view: PageView = hasPlan || planning || waiting || expected ? "plan" : "compose";
  // Without a plan the plan view shows only while one is on its way: planning, a plan waiting
  // for the places, or a shared or saved plan about to load.
  const content: PlanContent = planning
    ? "skeleton"
    : hasPlan
      ? "plan"
      : waiting && dataState.status === "error"
        ? "unavailable"
        : "skeleton";
  const summaryRequest = planning ? phase.request : (plan.itinerary?.request ?? null);
  const noticeBanner = notice ? (
    <Notice message={notice} onDismiss={() => setNotice(null)} testId="share-notice" />
  ) : null;
  const errorBanner =
    phase.kind === "error" ? (
      <ErrorState id="plan-error" message={phase.message} onRetry={retry} />
    ) : null;
  return (
    <div
      className="app"
      data-view={view}
      data-form-open={view === "plan" && formOpen ? "true" : "false"}
      data-testid="planner-app"
    >
      <div className="status-scrim" aria-hidden="true" />
      {view === "plan" ? (
        <a className="skip-link" href="#plan">
          Skip to your plan
        </a>
      ) : null}
      <AppHeader tagline={view === "compose"} />
      <OfflineBanner canPlan={ctx !== null} />
      <UpdatePrompt />
      <main className="app-body">
        <TripPane
          view={view}
          formOpen={formOpen}
          hasPlan={hasPlan}
          summaryRequest={summaryRequest}
          onEdit={() => openForm(true)}
          onBack={() => openForm(false)}
          headingRef={formHeading}
          notice={view === "compose" ? noticeBanner : null}
          error={view === "compose" ? errorBanner : null}
          form={form}
          dataState={dataState}
          onRetryData={retryData}
          planning={planning}
          slow={planning && phase.slow}
          onSubmit={submit}
        />
        {view === "compose" ? <Highlights ctx={ctx} /> : null}
        {view === "plan" ? (
          <PlanPane
            content={content}
            reason={planning ? "planning" : "opening"}
            slow={planning && phase.slow}
            notice={noticeBanner}
            error={errorBanner}
            onRetryData={retryData}
          >
            {hasPlan && ctx ? (
              <PlanView
                plan={plan}
                ctx={ctx}
                activeDay={activeDay}
                animateDay={animateDay}
                headingRef={heading}
                onSelectDay={(day) => {
                  setActiveDay(day);
                  setAnimateDay(-1);
                }}
                onUndo={edits.undo}
                onSwap={edits.startSwap}
                onRemove={edits.remove}
                onMove={edits.move}
                onStatus={(text) => announce(text)}
              />
            ) : null}
          </PlanPane>
        ) : null}
      </main>
      <AppFooter dataState={dataState} />
      <LiveRegion message={status.text} serial={status.serial} />
      <Toast
        message={status.edit && !formOpen ? status.text : null}
        serial={status.serial}
        undoLabel={undoLabel(plan)}
        onUndo={edits.undo}
      />
      {edits.swapping && plan.itinerary && ctx ? (
        <AlternativesPanel
          itinerary={plan.itinerary}
          ctx={ctx}
          target={edits.swapping}
          onChoose={edits.chooseSwap}
          onClose={edits.cancelSwap}
        />
      ) : null}
    </div>
  );
}
