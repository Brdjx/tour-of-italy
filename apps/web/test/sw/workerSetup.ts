import { builtSource, loadWorker, type RequestLike } from "./harness";

// Shared set-up for the worker tests: a built worker installed against a fake network, and the
// fixtures its API cache checks accept.

export const SHELL_HTML = "<!doctype html><title>shell</title>";
export const URLS = ["/", "/_next/static/chunks/app.js", "/manifest.webmanifest"];

export type Network = (request: RequestLike) => Promise<Response>;
export const offline: Network = async () => {
  throw new TypeError("Failed to fetch");
};
export const sha256 = async (text: string) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
};
export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
export const API = "italy-planner-api-v1";
/** A place with the fields the worker checks before it keeps a copy. */
export const P = (id: string) => ({
  id,
  name: `Place ${id}`,
  city: "Rome",
  lat: 41.9,
  lng: 12.5,
  durationMin: 60,
});
export const META = { anchors: [{ id: "rome", name: "Rome" }], interests: [] };

/** A worker built with a precache list, installed and activated against `network`. */
export async function installed(network: Network = async (r) => new Response(`body of ${r.url}`)) {
  let current = network;
  const worker = loadWorker({ source: builtSource("b1", URLS), network: (r) => current(r) });
  await worker.dispatch("install");
  await worker.dispatch("activate");
  return { worker, setNetwork: (next: Network) => (current = next) };
}

export async function answer(worker: ReturnType<typeof loadWorker>, request: RequestLike) {
  const event = worker.dispatchFetch(request);
  if (!event.responded) throw new Error("the worker did not handle this request");
  const response = await event.responded;
  await Promise.all(event.waits);
  return response;
}
