import { vi } from "vitest";

// A stand-in for maplibre-gl in jsdom, which has no WebGL. It records what the map component
// asks of it and puts markers and controls in the DOM the way MapLibre does. Test files use it
// with: vi.mock("maplibre-gl", async () => (await import("./fakeMapLibre")).maplibre);

type Handler = (event: Record<string, unknown>) => void;

// scale: screen px per degree, standing in for the zoom in project(). camera: what
// cameraForBounds answers (MapLibre's own framing), or undefined for "no answer".
export const state = {
  throwOnCreate: false,
  maps: [] as FakeMap[],
  scale: 100_000,
  camera: undefined as { center: { lng: number; lat: number }; zoom: number } | undefined,
};
export const basemap: { roundZoom?: boolean } = {};
// Plain arrays, not vi.fn(): the setup runs once per test file, and restoring mocks between
// tests would clear a spy's record of it.
export const workerUrls: string[] = [];
export const protocols: string[] = [];

export class FakeMap {
  options: Record<string, unknown>;
  container: HTMLElement;
  handlers = new Map<string, Handler[]>();
  fitBounds = vi.fn();
  setStyle = vi.fn();
  remove = vi.fn();
  resize = vi.fn();
  cameraForBounds = vi.fn(() => state.camera);
  cooperativeGestures = { enable: vi.fn(), disable: vi.fn() };
  touchZoomRotate = { disableRotation: vi.fn() };
  getSource = vi.fn((id: string) => (id === "basemap" ? basemap : undefined));
  constructor(options: Record<string, unknown>) {
    if (state.throwOnCreate) throw new Error("Could not create a WebGL2 context");
    this.options = options;
    this.container = options.container as HTMLElement;
    const canvas = document.createElement("canvas");
    canvas.className = "maplibregl-canvas";
    canvas.setAttribute("tabindex", "0");
    this.container.append(canvas);
    state.maps.push(this);
  }
  on(type: string, handler: Handler) {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), handler]);
    return this;
  }
  off(type: string, handler: Handler) {
    this.handlers.set(
      type,
      (this.handlers.get(type) ?? []).filter((known) => known !== handler),
    );
    return this;
  }
  project([lng, lat]: [number, number]) {
    return { x: lng * state.scale, y: -lat * state.scale };
  }
  emit(type: string, event: Record<string, unknown> = {}) {
    for (const handler of this.handlers.get(type) ?? []) handler(event);
  }
  addControl = vi.fn(() => {
    // MapLibre's compact attribution: a details element, open, with its toggle.
    const controls = document.createElement("div");
    controls.className = "maplibregl-control-container";
    const details = document.createElement("details");
    details.className = "maplibregl-ctrl-attrib maplibregl-compact maplibregl-compact-show";
    details.append(document.createElement("summary"));
    controls.append(details);
    this.container.append(controls);
  });
}

export class FakeMarker {
  element: HTMLElement;
  lngLat: [number, number] | null = null;
  offset: [number, number] = [0, 0];
  constructor(options: { element: HTMLElement }) {
    this.element = options.element;
  }
  setLngLat(lngLat: [number, number]) {
    this.lngLat = lngLat;
    return this;
  }
  setOffset(offset: [number, number]) {
    this.offset = offset;
    this.element.dataset.offset = offset.join(",");
    return this;
  }
  addTo(map: FakeMap) {
    map.container.append(this.element);
    return this;
  }
  remove() {
    this.element.remove();
  }
}

export class FakeAttribution {
  constructor(public options: Record<string, unknown>) {}
}

export const maplibre = {
  Map: FakeMap,
  Marker: FakeMarker,
  AttributionControl: FakeAttribution,
  setWorkerUrl: (url: string) => workerUrls.push(url),
  addProtocol: (name: string) => protocols.push(name),
};

export function resetFake(): void {
  state.throwOnCreate = false;
  state.maps.length = 0;
  state.scale = 100_000;
  state.camera = undefined;
}

export function lastMap(): FakeMap {
  const map = state.maps.at(-1);
  if (!map) throw new Error("No map was created");
  return map;
}

/**
 * matchMedia for the colour scheme, reduced motion and a pointer that hovers (a mouse, unless
 * `hover` is false, as on a phone), with a way to flip the scheme.
 */
export function stubMedia(
  initial: { dark?: boolean; reduced?: boolean; hover?: boolean } = {},
  onChange: (run: () => void) => void = (run) => run(),
) {
  const media = {
    dark: initial.dark ?? false,
    reduced: initial.reduced ?? false,
    hover: initial.hover ?? true,
  };
  const listeners = new Set<() => void>();
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() {
      if (query.includes("color-scheme: dark")) return media.dark;
      if (query.includes("reduced-motion: reduce")) return media.reduced;
      if (query.includes("hover: hover")) return media.hover;
      return false;
    },
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
  }));
  return {
    setDark(dark: boolean) {
      media.dark = dark;
      onChange(() => {
        for (const listener of listeners) listener();
      });
    },
  };
}
