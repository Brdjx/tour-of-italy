import type { Itinerary } from "@italy/planner";
import { createMemoryStore, type TripStore } from "../../src/trips/store";
import type { TestApp } from "./app";
import { FIXED_NOW, makeApp, postPlan, tripBody } from "./app";

// Helpers for the saved-trip tests: an app with a store the test can look into, an AI plan made
// through the app, and the body the page sends to save a trip.

export interface TripsApp extends TestApp {
  store: TripStore;
}

/** An app with an in-memory store the test holds, on the fixed test clock. */
export function tripsApp(options: Parameters<typeof makeApp>[0] = {}): TripsApp {
  const store = options.tripStore ?? createMemoryStore(() => FIXED_NOW);
  return { ...makeApp({ ...options, tripStore: store }), store: store as TripStore };
}

/** An AI plan made through POST /api/plan with the fixture's valid answer. */
export async function aiPlan(
  app: TestApp["app"],
  body: Record<string, unknown> = tripBody(),
): Promise<Itinerary> {
  const res = await postPlan(app, body, { scenario: "valid" });
  return (await res.json()) as Itinerary;
}

/** What the page sends to save `itinerary`: its request, each day's base and ids, and planId. */
export function saveBody(
  itinerary: Itinerary,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const { notes: _notes, ...request } = itinerary.request;
  return {
    request,
    days: itinerary.days.map((day) => ({
      anchorId: day.anchorId,
      ids: day.stops.map((stop) => stop.placeId),
    })),
    ...(itinerary.planId === undefined ? {} : { planId: itinerary.planId }),
    ...extra,
  };
}

export function postTrip(
  app: TestApp["app"],
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return Promise.resolve(
    app.request("/api/trips", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: text,
    }),
  );
}

export function getTrip(app: TestApp["app"], id: string): Promise<Response> {
  return Promise.resolve(app.request(`/api/trips/${id}`));
}

/** Saves `body` and returns the new id; fails the test on anything but 201. */
export async function saveTrip(app: TestApp["app"], body: unknown): Promise<string> {
  const res = await postTrip(app, body);
  const json = (await res.json()) as { id?: string };
  if (res.status !== 201 || json.id === undefined) {
    throw new Error(`save failed: ${res.status} ${JSON.stringify(json)}`);
  }
  return json.id;
}
