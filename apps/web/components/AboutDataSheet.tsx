"use client";

import type { DataSummary, Place, PlannerContext } from "@italy/planner";
import {
  Fragment,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  baseRows,
  creditRows,
  hoursCounts,
  NAMES_SHOWN,
  namesText,
  openAccessHours,
  plannerModel,
  typeRows,
  writtenWhen,
} from "../lib/aboutData";
import { fetchHealth } from "../lib/api";
import type { Health } from "../lib/apiSchemas";
import { plural } from "../lib/format";
import { summaryRecord } from "../lib/placeSummaries";
import { CLAIM_STARTS } from "../lib/sourceText";
import { SUMMARY_LABEL } from "./PlaceParts";
import { LicenceLink } from "./PlacePhotoImage";
import { Sheet, SheetTitleBar } from "./Sheet";

// "About this data", over the page: a full-height sheet on phones, a wide centred panel from
// 768 px with its own scrolling body (Sheet, about.css). Everything in it is computed from what
// the page loaded (the places, the planner's bases, the data notes from /api/data-issues, the
// saved place summaries, the photo credits) or read from /api/health (the model), so it can say
// nothing the data does not. The sections: the places by base and by type; what was cleaned or
// flagged and why, kind by kind with the places it touched; how opening hours and notes are
// treated; how a plan is made; the place summaries; every photo's credit; the map's credits.

interface AboutDataSheetProps {
  id: string;
  open: boolean;
  onClose: () => void;
  returnFocus: RefObject<HTMLElement | null>;
  places: readonly Place[];
  ctx: PlannerContext;
  summary: DataSummary;
  loadHealth?: (signal: AbortSignal) => Promise<Health>; // injected in tests
}

const defaultHealth = (signal: AbortSignal) => fetchHealth({ signal });

export function AboutDataSheet(props: AboutDataSheetProps) {
  const { id, open, onClose, returnFocus, places, ctx, summary } = props;
  const headingRef = useRef<HTMLHeadingElement>(null);
  const titleId = useId();
  const model = usePlannerModel(open, props.loadHealth ?? defaultHealth);
  return (
    <Sheet
      open={open}
      onClose={onClose}
      id={id}
      labelledBy={titleId}
      size="tall"
      className="about-sheet"
      testId="about-sheet"
      initialFocus={headingRef}
      returnFocus={returnFocus}
      header={
        <SheetTitleBar
          titleId={titleId}
          titleRef={headingRef}
          title="About this data"
          titleTestId="about-title"
          closeLabel="Close About this data"
          closeTestId="about-close"
          onClose={onClose}
        />
      }
    >
      <div className="about-body">
        <div className="about-lead">
          <p className="about-headline" data-testid="data-headline">
            {summary.headline}
          </p>
          <p className="about-note">
            The source listing is never edited. Every fix below is made in code as the data is read,
            and logged.
          </p>
        </div>
        <PlacesSection places={places} ctx={ctx} />
        <IssuesSection summary={summary} />
        <HoursSection places={places} />
        <PlanSection model={model} />
        <SummariesSection places={places} />
        <CreditsSection places={places} />
        <MapSection />
      </div>
    </Sheet>
  );
}

/** The planner's model from /api/health, asked for the first time the sheet opens. */
function usePlannerModel(
  open: boolean,
  load: (signal: AbortSignal) => Promise<Health>,
): string | null {
  const [model, setModel] = useState<string | null | undefined>(undefined);
  const asked = model !== undefined;
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    if (!open || asked) return;
    const controller = new AbortController();
    loadRef.current(controller.signal).then(
      (health) => {
        if (!controller.signal.aborted) setModel(plannerModel(health));
      },
      () => {
        if (!controller.signal.aborted) setModel(null);
      },
    );
    return () => controller.abort();
  }, [open, asked]);
  return model ?? null;
}

function Section({
  title,
  testId,
  children,
}: {
  title: string;
  testId: string;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <section className="about-section" aria-labelledby={headingId} data-testid={testId}>
      <h3 id={headingId} className="about-heading">
        {title}
      </h3>
      {children}
    </section>
  );
}

function PlacesSection({ places, ctx }: { places: readonly Place[]; ctx: PlannerContext }) {
  const bases = useMemo(() => baseRows(ctx), [ctx]);
  const types = useMemo(() => typeRows(places), [places]);
  return (
    <Section title="The places" testId="about-places">
      <p className="about-text">
        Each day is planned from one of {bases.length} bases, with day trips to the towns near it.
      </p>
      <table className="about-table" data-testid="about-bases">
        <thead>
          <tr>
            <th scope="col">Base</th>
            <th scope="col" className="about-num">
              In the city
            </th>
            <th scope="col">Day trips</th>
            <th scope="col" className="about-num">
              Places
            </th>
          </tr>
        </thead>
        <tbody>
          {bases.map((row) => (
            <tr key={row.base}>
              <th scope="row">{row.base}</th>
              <td className="about-num">{row.inCity}</td>
              <td>
                {row.dayTrips.length === 0 ? (
                  <span className="text-muted">None</span>
                ) : (
                  row.dayTrips.map((trip, index) => (
                    // Decision: the comma sits outside the unbreakable town and count, so a long
                    // list wraps between towns on a phone instead of pushing the table sideways.
                    <Fragment key={trip.city}>
                      {index > 0 ? ", " : null}
                      <span className="about-trip">
                        {trip.city} <span className="tabular">{trip.count}</span>
                      </span>
                    </Fragment>
                  ))
                )}
              </td>
              <td className="about-num">{row.total}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h4 className="about-subheading">By type</h4>
      <dl className="about-counts" data-testid="about-types">
        {types.map((row) => (
          <div key={row.label} className="about-count">
            <dt>{row.label}</dt>
            <dd className="tabular">{row.count}</dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}

function IssuesSection({ summary }: { summary: DataSummary }) {
  return (
    <Section title="What was cleaned or flagged, and why" testId="about-issues">
      <p className="about-text">
        Reading the data, the planner logged {plural(summary.totals.issues, "note", "notes")} of{" "}
        {plural(summary.items.length, "kind", "kinds")}. Each kind below says what it means for a
        plan and names the places it touched.
      </p>
      <ul className="about-groups">
        {summary.items.map((item) => (
          <li key={item.kind} className="about-group" data-testid="about-issue">
            <p className="about-group-head">
              <span className="about-group-title">{item.title}</span>
              <span className="about-group-count tabular">
                {plural(item.count, "place", "places")}
              </span>
            </p>
            <p className="about-group-text">{item.explanation}</p>
            <GroupNames places={item.places} />
          </li>
        ))}
      </ul>
    </Section>
  );
}

/** The places of one kind: all of them when few, else the first few and a way to see the rest. */
function GroupNames({ places }: { places: readonly { name: string }[] }) {
  if (places.length === 0) return null;
  if (places.length <= NAMES_SHOWN) {
    return <p className="about-group-names">{namesText(places)}</p>;
  }
  return (
    <details className="about-names">
      <summary className="about-names-summary">
        <span className="about-names-preview">{namesText(places)}</span>
        <span className="about-names-toggle">
          <span className="when-closed">Show all {places.length}</span>
          <span className="when-open">Show fewer</span>
        </span>
      </summary>
      <p className="about-group-names">{places.map((place) => place.name).join(", ")}</p>
    </details>
  );
}

function HoursSection({ places }: { places: readonly Place[] }) {
  const counts = useMemo(() => hoursCounts(places), [places]);
  const rows = [
    { label: "Listed in the data", count: counts.listed },
    { label: "Estimated from the listing", count: counts.estimated },
    { label: "Public spaces, no set hours", count: counts.openAccess },
    { label: "Not in the data", count: counts.unknown },
  ];
  return (
    <Section title="Opening hours and notes" testId="about-hours">
      <p className="about-text">
        A plan is checked against each place's hours on the trip's own dates. A note that narrows
        them (open only in some months, or only on some days) is applied; a note that would extend
        them, such as longer summer hours, is shown but never used, since a wrong opening time sends
        a traveler to a closed door while a wrong closing time only hides one option. Hours given
        only in words are estimated, public spaces with no listed hours are planned from{" "}
        <span className="tabular">{openAccessHours()}</span>, and a place with no hours can still be
        planned, with a warning.
      </p>
      <dl className="about-counts about-counts--wide">
        {rows.map((row) => (
          <div key={row.label} className="about-count">
            <dt>{row.label}</dt>
            <dd className="tabular">{row.count}</dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}

function PlanSection({ model }: { model: string | null }) {
  return (
    <Section title="How a plan is made" testId="about-plan">
      <p className="about-text" data-testid="about-plan-text">
        The AI planner{model ? <> (Claude, model {model})</> : null} chooses a base for each day,
        puts places from a shortlist in order, and writes each stop's one-line reason and the trip
        summary. Code builds the shortlist, sets every time and travel leg, and checks the AI's
        words: a reason that does not hold for its stop is replaced by one code writes, and a
        sentence of the summary that fails a check is dropped. An independent check then tests the
        plan against the opening hours on its dates, meal times, travel between stops and the pace.
        A plan that fails is repaired once or replaced by one made by rules alone, which also plans
        when the AI is unavailable or there is no connection, and the page says which one it is.
      </p>
      {/* Decision: what the source line under the trip's dates means, said once here, so the line
          itself can stay one line of facts (components/SourceBadge.tsx). Each claim is a row
          keyed by the words the line starts with, so a traveler finds the line they saw. */}
      <p className="about-text" data-testid="about-plan-line">
        The line under the trip's dates says how the plan on screen was made. Its check means every
        stop passed that check: gold when the AI planner chose the places and wrote the reasons, ink
        when the reasons come from the rules.
      </p>
      <dl className="about-groups about-claims" data-testid="about-plan-claims">
        {CLAIM_MEANINGS.map(([claim, meaning]) => (
          <div key={claim} className="about-group" data-testid="about-plan-claim">
            <dt className="about-group-title">{claim}</dt>
            <dd className="about-group-text">{meaning}</dd>
          </div>
        ))}
      </dl>
      <p className="about-text" data-testid="about-plan-marks">
        After a change the line adds "edited". Every edit is checked again, and a red dot with a
        count to fix in place of the check means the plan breaks a rule now: the flagged stops and
        days say which. On each stop, a filled gold dot marks a reason the AI wrote and an open dot
        one the rules wrote.
      </p>
    </Section>
  );
}

/** What each claim of the source line means, by the words it starts with (lib/sourceText.ts). */
const CLAIM_MEANINGS: ReadonlyArray<readonly [string, string]> = [
  [
    CLAIM_STARTS.ai,
    "The AI planner chose the places and wrote the reasons, and its plan passed the check as it wrote it.",
  ],
  [
    CLAIM_STARTS.repaired,
    "The AI's first draft broke a rule, so code dropped or reordered stops, or asked the AI to fix it.",
  ],
  [
    CLAIM_STARTS.rules,
    "The rules made the plan. The words after the colon say why the AI's plan was not used: the planner was off, timed out, was busy, declined or failed, its plan broke a rule, or the server could not be reached.",
  ],
  [
    CLAIM_STARTS.device,
    "No plan this page could use came from the server, so it made one by rules. The words after it say why, when the page knows.",
  ],
  [
    CLAIM_STARTS.shared,
    "A shared link carries only the trip's settings and places, so its plan is rebuilt here with the current data: its times worked out again and its reasons from the rules.",
  ],
  [
    CLAIM_STARTS.saved,
    'A saved link keeps the times and reasons the trip was saved with, and the line adds "planned with AI" when the AI planned it, and the day it was saved. If the place data has changed since, its times are worked out again and its reasons come from the rules.',
  ],
];

function SummariesSection({ places }: { places: readonly Place[] }) {
  const record = useMemo(() => summaryRecord(places.map((place) => place.id)), [places]);
  if (record.count === 0) return null;
  const without = places.length - record.count;
  return (
    <Section title="Place summaries" testId="about-summaries">
      <p className="about-text" data-testid="about-summaries-text">
        {record.count} of the {plural(places.length, "place", "places")}{" "}
        {record.count === 1 ? "has" : "have"} a one or two sentence summary, labelled "
        {SUMMARY_LABEL}" in their sheet
        {without > 0 ? <>; the other {plural(without, "has", "have")} none</> : null}. Claude (
        {record.models.length === 1 ? "model" : "models"} {namesText(record.models.map(asName))})
        wrote each one {writtenWhen(record)} from that place's own listing alone, and code checked
        it before it was saved: it refuses a number, time, date, price, booking claim, meal, name or
        superlative the listing does not have.
      </p>
    </Section>
  );
}

const asName = (name: string) => ({ name });

function CreditsSection({ places }: { places: readonly Place[] }) {
  const credits = useMemo(() => creditRows(places), [places]);
  const own = credits.filter((row) => row.kind === "place").length;
  const cities = credits.filter((row) => row.kind === "city").length;
  const scenes = credits.length - own - cities;
  const standIns =
    scenes === 0
      ? `the other ${cities} show a city`
      : `the other ${cities + scenes} show a city or a general scene`;
  return (
    <Section title="Photo credits" testId="about-credits">
      <p className="about-text">
        {plural(credits.length, "photo", "photos")}, all from Wikimedia Commons, each shown with its
        author and licence. {own} show the place itself; {standIns}, labelled as such and never
        presented as the place.
      </p>
      <details className="about-names about-credits-list">
        <summary className="about-names-summary">
          <span className="about-names-toggle">
            <span className="when-closed">Show every photo's credit</span>
            <span className="when-open">Hide the credits</span>
          </span>
        </summary>
        <ul className="about-credits" data-testid="about-credit-list">
          {credits.map((row) => (
            <li key={row.key}>
              <span className="about-credit-name">{row.name}</span>{" "}
              <span className="about-credit-by">
                Photo: {row.author}, <LicenceLink photo={row} />
              </span>
              {/* Decision: the work's title as the link, as the CC 2.0 and 3.0 licences ask when
                  one is given, and every Commons file has one. */}
              <span className="about-credit-source">
                <a href={row.sourceUrl} target="_blank" rel="noreferrer noopener">
                  {row.title}
                </a>{" "}
                on Wikimedia Commons
              </span>
            </li>
          ))}
        </ul>
      </details>
    </Section>
  );
}

function MapSection() {
  return (
    <Section title="The map" testId="about-map">
      <p className="about-text">
        Map data ©{" "}
        <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer noopener">
          OpenStreetMap contributors
        </a>
        , drawn from a{" "}
        <a href="https://protomaps.com" target="_blank" rel="noreferrer noopener">
          Protomaps
        </a>{" "}
        basemap served from this site. Travel times are estimated from straight-line distance, not a
        routing service.
      </p>
    </Section>
  );
}
