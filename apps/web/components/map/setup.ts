import { addProtocol, setWorkerUrl } from "maplibre-gl";
import { Protocol } from "pmtiles";
import { WORKER_PATH } from "../../lib/mapStyle";

// One-time setup before the first map: where MapLibre's worker lives, and how it reads the
// tile archive. Loaded only with the map's own code (see DayMap).

let ready = false;

export function setUpMap(origin: string): void {
  if (ready) return;
  setWorkerUrl(`${origin}${WORKER_PATH}`);
  // pmtiles:// URLs are read with HTTP range requests from the one archive file.
  addProtocol("pmtiles", new Protocol().tile);
  ready = true;
}
