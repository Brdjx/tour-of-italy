"use client";

// Decision: first import, before anything that builds a Zod schema (see lib/zodSetup.ts).
import "../lib/zodSetup";
import { privateAiText, summaryForTrip, type TripRequest } from "@italy/planner";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flaggedStopCount } from "../lib/chips";
import { type DayCallDeps, replannedAiDays } from "../lib/dayCity";
import { useEditFocus } from "../lib/editFocus";
import { isEdited, undoLabel } from "../lib/itineraryReducer";
import { restoredNote } from "../lib/lastPlan";
import type { PlanDeps } from "../lib/planRequest";
import { type FetchTrip, SAVED_NOTES } from "../lib/savedTrip";
import { defaultFormValues, valuesFromRequest } from "../lib/tripForm";
import { useDayCity } from "../lib/useDayCity";
import { useFirstScreen } from "../lib/useFirstScreen";
import { useItinerary } from "../lib/useItinerary";
import { type RestoredPlan, useLastPlan } from "../lib/useLastPlan";
import { usePageFocus } from "../lib/usePageFocus";
import { usePlanEdits } from "../lib/usePlanEdits";
import { usePlanExpected } from "../lib/usePlanExpected";
import { type PlanPhase, usePlanTrip } from "../lib/usePlanTrip";
import { useSavedTripOnLoad } from "../lib/useSavedTrip";
import { useSharedLinkOnLoad } from "../lib/useSharedLink";
import { type TripDataLoader, useTripData } from "../lib/useTripData";
import { AlternativesPanel } from "./AlternativesPanel";
import { prefetchMap } from "./DayMap";
import { ErrorState, Notice } from "./ErrorState";
import { Highlights } from "./Highlights";
import { OfflineBanner } from "./OfflineBanner";
import { AppFooter, AppHeader, type PlanContent, PlanPane } from "./PlanPane";
import { PlanView } from "./PlanView";
import type { SaveTrip } from "./ShareButton";
import { LiveRegion, Toast } from "./StatusRegion";
import { TricoloreBand } from "./Tricolore";
import { type PageView, TripPane } from "./TripPane";
import { TripSummary } from "./TripSummary";
import { UpdatePrompt } from "./UpdatePrompt";

// The whole page. Before any plan it is one calm column: the start date, the pace, "More
// options" and "Plan my trip", which all work before the data arrives. From the moment a plan
// is asked for, the page opens on the trip header (the dates, Edit trip, Copy link, how it was
// planned) and the plan area shows the plan's skeleton, then the plan; the form moves into the
// Edit trip sheet (see app/styles/layout.css and sheet.css). "Start a new trip" in that sheet
// clears the plan and brings back the first screen.

/** What the live region says after "Start a new trip". */
export const STARTED_OVER = "Started a new trip. Your last plan is cleared from this device.";

export interface PlannerAppProps {
  loader?: TripDataLoader; // injected in tests
  post?: PlanDeps["post"]; // injected in tests
  postDay?: DayCallDeps["post"]; // POST /api/plan/day; injected in tests
  saveTrip?: SaveTrip; // POST /api/trips; injected in tests
  fetchTrip?: FetchTrip; // GET /api/trips/:id; injected in tests
  today?: () => Date;
}

export function PlannerApp({
  loader,
  post,
  postDay,
  saveTrip,
  fetchTrip,
  today = () => new Date(),
}: PlannerAppProps) {
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
  // A failed request that "Start a new trip" put away, so its message does not follow the
  // traveler back to the first screen. A new request is a new phase and shows its own.
  const [dismissedPhase, setDismissedPhase] = useState<PlanPhase | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const startHeading = useRef<HTMLHeadingElement>(null);
  const appRef = useRef<HTMLDivElement>(null);
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

  // Change city and New ideas for this day: the answer goes in through the edits above, and the
  // day's rows arrive the way a new plan's do when it is the day on screen.
  const dayCity = useDayCity({
    plan,
    ctx,
    post: postDay,
    announce,
    apply: edits.applyDay,
    onPlanned: setAnimateDay,
  });

  const restore = (restored: RestoredPlan) => {
    const { itinerary, origin, cause, saved, edited, dayMade, flagged } = restored;
    const message = "Showing your last plan.";
    dispatch({ type: "plan", itinerary, origin, cause, saved, edited, dayMade, message });
    setForm((current) => ({ key: current.key + 1, values: valuesFromRequest(itinerary.request) }));
    setNotice(restoredNote(flagged, saved?.retimed === true));
  };
  const forgetLastPlan = useLastPlan(ctx, plan, restore, { now: today });

  const dropSharedLink = useSharedLinkOnLoad(ctx, (result) => {
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

  // A saved trip shows exactly as it was saved (or timed again when the place data changed); a
  // trip that cannot be opened leaves its note over the form.
  const savedLink = useSavedTripOnLoad(
    ctx,
    (result) => {
      if (result.status === "plan") {
        dispatch({
          type: "plan",
          itinerary: result.itinerary,
          origin: "saved",
          saved: result.saved,
          message: result.note ?? SAVED_NOTES.opened,
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
    },
    fetchTrip,
  );
  const savedPending = savedLink.pending;

  // A saved trip opened while the API is down waits for the places, which "Try again" brings;
  // until then the note over the form says it will open, and the trip replaces the note when it
  // does (or the note that says why it could not).
  useEffect(() => {
    if (dataState.status === "error" && savedPending) setNotice(SAVED_NOTES.waiting);
  }, [dataState.status, savedPending]);

  // After the hooks above, so a restored, shared or saved plan replaces the skeleton in one step.
  // A saved trip may arrive after the places, so the skeleton waits for it too.
  const expected = usePlanExpected(
    dataState.status === "error" || (dataState.status === "ready" && !savedPending),
  );
  const setFocusNext = usePageFocus({
    phase,
    planId: plan.planId,
    dayHeading: heading,
    startHeading,
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

  // Opening the sheet puts focus on its heading (Sheet); closing it returns to "Edit trip".
  const openForm = (open: boolean) => {
    setFormOpen(open);
    if (!open) setFocusNext("edit");
  };

  const submit = (request: TripRequest) => {
    // Decision: the values that were sent, so the form that mounts in the Edit trip sheet (or
    // back on the first screen after a failed first plan) shows exactly what was planned. The
    // key stays: a form already in the sheet keeps its state, which is the same thing.
    setForm((current) => ({ key: current.key, values: valuesFromRequest(request) }));
    setFormOpen(false);
    setFocusNext("plan");
    // Decision: a shared or saved-trip link still on its way is given up. The traveler's own
    // request is the newer one, so the link must not open over the plan they asked for, and its
    // note ("will open once the connection is back") would no longer be true.
    const droppedShared = dropSharedLink();
    const droppedSaved = savedLink.drop();
    if (droppedShared || droppedSaved) setNotice(null);
    void planTrip(request);
  };

  // "Start a new trip": the saved plan, the shared-link note and the plan on screen go, and the
  // first screen comes back with the default values. Offered only while no plan is on its way,
  // since a request in flight would bring a plan back.
  const startOver = () => {
    forgetLastPlan();
    dispatch({ type: "clear" });
    setForm((current) => ({ key: current.key + 1, values: defaultFormValues(today()) }));
    setFormOpen(false);
    setNotice(null);
    setActiveDay(0);
    setAnimateDay(-1);
    setDismissedPhase(phase);
    setFocusNext("start");
    announce(STARTED_OVER);
  };

  const planning = phase.kind === "planning";
  const hasPlan = plan.itinerary !== null && ctx !== null;
  const waiting = plan.itinerary !== null && ctx === null; // a plan came before the places
  const view: PageView = hasPlan || planning || waiting || expected ? "plan" : "compose";
  useFirstScreen(appRef, "trip-form-pane", view === "compose");
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
  const shownPlan = content === "plan" ? plan.itinerary : null;
  // What a saved trip of the plan leaves out, counted on the summary as the page shows it.
  const privateText = useMemo(
    () =>
      shownPlan && ctx
        ? privateAiText({ ...shownPlan, summary: summaryForTrip(shownPlan, ctx) })
        : { summary: false, reasons: 0 },
    [shownPlan, ctx],
  );
  const noticeBanner = notice ? (
    <Notice message={notice} onDismiss={() => setNotice(null)} testId="share-notice" />
  ) : null;
  const errorBanner =
    phase.kind === "error" && phase !== dismissedPhase ? (
      <ErrorState id="plan-error" message={phase.message} onRetry={retry} />
    ) : null;
  return (
    <div ref={appRef} className="app" data-view={view} data-testid="planner-app">
      <div className="status-scrim" aria-hidden="true" />
      {/* The page itself, which scales back behind a sheet on phones (sheet.css). */}
      <div className="app-page">
        <TricoloreBand />
        {view === "plan" ? (
          <a className="skip-link" href="#plan">
            Skip to your plan
          </a>
        ) : null}
        {view === "compose" ? <AppHeader titleRef={startHeading} /> : null}
        <OfflineBanner canPlan={ctx !== null} />
        <UpdatePrompt />
        <main className="app-body">
          {view === "plan" ? (
            <TripSummary
              request={summaryRequest}
              onEdit={() => openForm(true)}
              editing={formOpen}
              planning={planning}
              plan={
                shownPlan
                  ? {
                      itinerary: shownPlan,
                      origin: plan.origin,
                      cause: plan.cause,
                      saved: plan.saved,
                      errors: plan.errors.length,
                      flaggedStops: flaggedStopCount(plan.errors),
                      edited: isEdited(plan),
                      privateText,
                      replannedAi: replannedAiDays(shownPlan, plan.dayMade),
                      now: today(),
                    }
                  : null
              }
              undoLabel={undoLabel(plan)}
              onUndo={edits.undo}
              onStatus={(text) => announce(text)}
              {...(saveTrip ? { saveTrip } : {})}
            />
          ) : null}
          <TripPane
            view={view}
            formOpen={formOpen}
            hasPlan={hasPlan}
            onBack={() => openForm(false)}
            onStartOver={hasPlan && !planning ? startOver : undefined}
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
                  onSwap={edits.startSwap}
                  onRemove={edits.remove}
                  onMove={edits.move}
                  dayCity={dayCity}
                />
              ) : null}
            </PlanPane>
          ) : null}
        </main>
        <AppFooter dataState={dataState} />
      </div>
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
