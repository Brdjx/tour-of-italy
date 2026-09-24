import { describe, expect, it, vi } from "vitest";
import {
  canRegister,
  checkWhenVisible,
  type PendingUpdate,
  SKIP_WAITING,
  type SwEnvironment,
  startServiceWorker,
  UPDATE_CHECK_INTERVAL_MS,
} from "../../lib/sw/register";

// Registration and the new-version flow, with fake browser objects. What would break the
// product: a worker registered under `next dev` or in tests (stale code served from a cache),
// files swapped under a running page without the traveler's tap, a reload loop, a prompt on the
// very first visit, or a failed registration crashing the page.

class FakeWorker extends EventTarget {
  readonly messages: unknown[] = [];
  constructor(public state: ServiceWorkerState) {
    super();
  }
  postMessage(message: unknown) {
    this.messages.push(message);
  }
  moveTo(state: ServiceWorkerState) {
    this.state = state;
    this.dispatchEvent(new Event("statechange"));
  }
}

class FakeRegistration extends EventTarget {
  waiting: FakeWorker | null = null;
  installing: FakeWorker | null = null;
  updates = 0;
  failUpdate = false;
  async update() {
    this.updates += 1;
    if (this.failUpdate) throw new TypeError("Failed to fetch");
  }
  startInstall(worker: FakeWorker) {
    this.installing = worker;
    this.dispatchEvent(new Event("updatefound"));
  }
}

class FakeContainer extends EventTarget {
  readonly registration = new FakeRegistration();
  readonly registerCalls: unknown[][] = [];
  failRegister = false;
  constructor(public controller: FakeWorker | null) {
    super();
  }
  register(url: string, options: unknown) {
    this.registerCalls.push([url, options]);
    if (this.failRegister) return Promise.reject(new DOMException("blocked", "SecurityError"));
    return Promise.resolve(this.registration);
  }
  changeController(worker: FakeWorker) {
    this.controller = worker;
    this.dispatchEvent(new Event("controllerchange"));
  }
}

class FakeDoc extends EventTarget {
  visibilityState: DocumentVisibilityState = "visible";
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function start(controller: FakeWorker | null, prepare: (c: FakeContainer) => void = () => {}) {
  const container = new FakeContainer(controller);
  prepare(container);
  const updates: PendingUpdate[] = [];
  const reload = vi.fn();
  const env: SwEnvironment = {
    nodeEnv: "production",
    isSecureContext: true,
    container: container as unknown as ServiceWorkerContainer,
  };
  const doc = new FakeDoc() as unknown as Document;
  const stop = startServiceWorker((update) => updates.push(update), { env, reload, doc });
  return { container, registration: container.registration, updates, reload, stop };
}

describe("canRegister", () => {
  it("never registers a worker outside a production build", () => {
    const container = new FakeContainer(null) as unknown as ServiceWorkerContainer;
    for (const nodeEnv of ["development", "test", "", undefined]) {
      expect(canRegister({ nodeEnv, isSecureContext: true, container })).toBe(false);
    }
  });

  it("never registers on an insecure page or in a browser without service workers", () => {
    const container = new FakeContainer(null) as unknown as ServiceWorkerContainer;
    expect(canRegister({ nodeEnv: "production", isSecureContext: false, container })).toBe(false);
    expect(
      canRegister({ nodeEnv: "production", isSecureContext: true, container: undefined }),
    ).toBe(false);
    expect(canRegister({ nodeEnv: "production", isSecureContext: true, container })).toBe(true);
  });

  it("does not call register at all in development or in this test run's own environment", () => {
    const container = new FakeContainer(null);
    const env = {
      nodeEnv: "development",
      isSecureContext: true,
      container: container as unknown as ServiceWorkerContainer,
    };
    startServiceWorker(() => {}, { env });
    startServiceWorker(() => {});
    expect(container.registerCalls).toEqual([]);
  });
});

describe("startServiceWorker", () => {
  it("registers /sw.js for the whole site and skips the HTTP cache when checking for updates", () => {
    const { container } = start(null);
    expect(container.registerCalls).toEqual([["/sw.js", { scope: "/", updateViaCache: "none" }]]);
  });

  it("offers nothing and never reloads on the very first install", async () => {
    const { registration, container, updates, reload } = start(null);
    await flush();
    const first = new FakeWorker("installing");
    registration.startInstall(first);
    first.moveTo("installed");
    container.changeController(first); // clients.claim() on activate
    expect(updates).toHaveLength(0);
    expect(reload).not.toHaveBeenCalled();
  });

  it("offers an update on a controlled page and swaps only after the traveler taps Reload", async () => {
    const { registration, container, updates, reload } = start(new FakeWorker("activated"));
    await flush();
    const next = new FakeWorker("installing");
    registration.startInstall(next);
    next.moveTo("installed");
    expect(updates).toHaveLength(1);
    expect(next.messages).toEqual([]);
    updates[0]?.apply();
    expect(next.messages).toEqual([SKIP_WAITING]);
    expect(reload).not.toHaveBeenCalled();
    container.changeController(next);
    container.changeController(next);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("offers a worker that was already waiting from an earlier visit", async () => {
    const waiting = new FakeWorker("installed");
    const { updates } = start(new FakeWorker("activated"), (c) => {
      c.registration.waiting = waiting;
    });
    await flush();
    expect(updates).toHaveLength(1);
    updates[0]?.apply();
    expect(waiting.messages).toEqual([SKIP_WAITING]);
  });

  it("offers a plain reload in this tab when another tab applied the update", async () => {
    const { container, updates, reload } = start(new FakeWorker("activated"));
    await flush();
    container.changeController(new FakeWorker("activated"));
    expect(updates).toHaveLength(1);
    expect(reload).not.toHaveBeenCalled();
    updates[0]?.apply();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("reloads at once when the offered worker already took over, instead of waiting forever", async () => {
    const { registration, updates, reload } = start(new FakeWorker("activated"));
    await flush();
    const next = new FakeWorker("installing");
    registration.startInstall(next);
    next.moveTo("installed");
    next.state = "activated";
    updates[0]?.apply();
    expect(next.messages).toEqual([]);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("shows nothing and throws nothing when the browser refuses to register", async () => {
    const { updates, reload } = start(null, (c) => {
      c.failRegister = true;
    });
    await flush();
    expect(updates).toEqual([]);
    expect(reload).not.toHaveBeenCalled();
  });

  // Found in WebKit with service workers blocked. A throw here is an unhandled rejection, which
  // fails the whole Vitest run.
  it("ignores a stubbed register() that resolves with nothing instead of throwing", async () => {
    const { updates } = start(new FakeWorker("activated"), (c) => {
      c.register = () => Promise.resolve(undefined as unknown as FakeRegistration);
    });
    await flush();
    expect(updates).toEqual([]);
  });

  it("stops offering updates once the page stops listening", async () => {
    const { registration, container, updates, stop } = start(new FakeWorker("activated"));
    await flush();
    stop();
    const next = new FakeWorker("installing");
    registration.startInstall(next);
    next.moveTo("installed");
    container.changeController(next);
    expect(updates).toEqual([]);
  });
});

describe("checkWhenVisible", () => {
  it("looks for a new version on return to the app at most once an hour", () => {
    const registration = new FakeRegistration();
    const doc = new FakeDoc();
    let now = 0;
    checkWhenVisible(registration, doc as unknown as Document, () => now);
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(registration.updates).toBe(0);
    now = UPDATE_CHECK_INTERVAL_MS;
    doc.visibilityState = "hidden";
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(registration.updates).toBe(0);
    doc.visibilityState = "visible";
    doc.dispatchEvent(new Event("visibilitychange"));
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(registration.updates).toBe(1);
  });

  it("swallows a failed check while offline and stops when asked", async () => {
    const registration = new FakeRegistration();
    registration.failUpdate = true;
    const doc = new FakeDoc();
    let now = 0;
    const stop = checkWhenVisible(registration, doc as unknown as Document, () => now);
    now = UPDATE_CHECK_INTERVAL_MS;
    doc.dispatchEvent(new Event("visibilitychange"));
    await flush();
    stop();
    now = 10 * UPDATE_CHECK_INTERVAL_MS;
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(registration.updates).toBe(1);
  });
});
