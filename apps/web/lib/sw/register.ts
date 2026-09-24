// Service worker registration and the new-version flow. Framework-free, so the tests drive it
// with fake containers, registrations and workers.
//
// Flow: a new deploy changes /sw.js, the browser installs the new worker next to the running
// one, and it waits. The page offers "A new version is available. Reload"; only that tap sends
// SKIP_WAITING, and the page reloads once the new worker has taken control. Nothing is swapped
// under a page the traveler is using.

export const SW_URL = "/sw.js";
export const SKIP_WAITING = { type: "SKIP_WAITING" } as const;
// Decision: an installed app can stay open for days, and the browser only looks for a new
// worker on navigation. Look again when the app comes back to the foreground, at most hourly.
export const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

export interface SwEnvironment {
  nodeEnv: string | undefined;
  isSecureContext: boolean;
  container: ServiceWorkerContainer | undefined;
}

/** A new version waiting to be used. `apply` activates it and reloads the page. */
export interface PendingUpdate {
  apply: () => void;
}

type VisibilityDoc = Pick<Document, "addEventListener" | "removeEventListener" | "visibilityState">;

export interface StartOptions {
  env?: SwEnvironment;
  reload?: () => void;
  doc?: VisibilityDoc;
  now?: () => number;
}

// Decision: production builds only. Under `next dev` a worker would cache dev bundles and serve
// stale code after every edit, and tests must never register one.
export function canRegister(
  env: SwEnvironment,
): env is SwEnvironment & { container: ServiceWorkerContainer } {
  return env.nodeEnv === "production" && env.isSecureContext && env.container !== undefined;
}

export function browserEnvironment(): SwEnvironment {
  const hasWindow = typeof window !== "undefined";
  const container =
    typeof navigator !== "undefined" && "serviceWorker" in navigator
      ? navigator.serviceWorker
      : undefined;
  return {
    nodeEnv: process.env.NODE_ENV,
    isSecureContext: hasWindow && window.isSecureContext,
    container,
  };
}

/**
 * Registers the worker and calls `onUpdate` whenever a new version is ready. Never throws and
 * does nothing outside production. Returns a function that stops listening.
 */
export function startServiceWorker(
  onUpdate: (update: PendingUpdate) => void,
  options: StartOptions = {},
): () => void {
  const env = options.env ?? browserEnvironment();
  if (!canRegister(env)) return () => {};
  const container = env.container;
  const reload = options.reload ?? (() => window.location.reload());
  const state = {
    stopped: false,
    reloadRequested: false,
    reloaded: false,
    hadController: container.controller !== null,
  };
  const cleanups: Array<() => void> = [];

  const reloadOnce = () => {
    if (state.reloaded) return;
    state.reloaded = true;
    reload();
  };
  const apply = (worker: ServiceWorker | null) => {
    state.reloadRequested = true;
    // A worker that is still waiting is told to take over; the reload follows on
    // controllerchange. One that already took over (another tab applied it) needs only a reload.
    if (worker && worker.state === "installed") worker.postMessage(SKIP_WAITING);
    else reloadOnce();
  };
  const offer = (worker: ServiceWorker | null) => {
    if (!state.stopped) onUpdate({ apply: () => apply(worker) });
  };

  const onControllerChange = () => {
    if (state.reloadRequested) {
      reloadOnce();
      return;
    }
    // The first worker claiming the page is not an update. A later change means another tab
    // applied one, and this page still runs the old files: offer the reload here too.
    if (state.hadController) offer(null);
    state.hadController = true;
  };
  container.addEventListener("controllerchange", onControllerChange);
  cleanups.push(() => container.removeEventListener("controllerchange", onControllerChange));

  container.register(SW_URL, { scope: "/", updateViaCache: "none" }).then(
    (registration: ServiceWorkerRegistration | undefined) => {
      // Some embedded browsers and test harnesses stub register() and resolve with nothing.
      if (state.stopped || !registration) return;
      watchRegistration(registration, container, offer);
      const doc = options.doc ?? document;
      cleanups.push(checkWhenVisible(registration, doc, options.now ?? Date.now));
    },
    () => {
      // Decision: a failed registration (private mode, blocked storage) is not shown. The app
      // works online without a worker; only offline support is missing.
    },
  );

  return () => {
    state.stopped = true;
    for (const cleanup of cleanups) cleanup();
  };
}

/** Offers a worker that is waiting now, or that finishes installing later, as an update. */
export function watchRegistration(
  registration: ServiceWorkerRegistration,
  container: ServiceWorkerContainer,
  offer: (worker: ServiceWorker) => void,
): void {
  // With no controller this is the first install: it takes over without changing the page, so
  // there is nothing to offer.
  if (registration.waiting && container.controller) offer(registration.waiting);
  registration.addEventListener("updatefound", () => {
    const worker = registration.installing;
    if (!worker) return;
    worker.addEventListener("statechange", () => {
      if (worker.state === "installed" && container.controller) offer(worker);
    });
  });
}

/** Asks the browser to look for a new worker when the page becomes visible, at most hourly. */
export function checkWhenVisible(
  registration: { update: () => Promise<unknown> },
  doc: VisibilityDoc,
  now: () => number,
  interval: number = UPDATE_CHECK_INTERVAL_MS,
): () => void {
  let last = now();
  const onChange = () => {
    if (doc.visibilityState !== "visible" || now() - last < interval) return;
    last = now();
    registration.update().catch(() => {
      // Offline or the server is down: the next return to the app tries again.
    });
  };
  doc.addEventListener("visibilitychange", onChange);
  return () => doc.removeEventListener("visibilitychange", onChange);
}
