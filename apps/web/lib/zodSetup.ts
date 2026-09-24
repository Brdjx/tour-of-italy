import { z } from "zod";

// Zod settings for the browser, applied before any schema is built.
// Decision: jitless. Zod 4 otherwise probes `new Function("")` to decide whether it may compile
// fast parsers, and under the site's CSP (no 'unsafe-eval') that probe is reported as a
// violation on every page load. The probe result is read when an object schema is created, so
// this module must be imported before @italy/planner or any local schema module: PlannerApp
// imports it first. The interpreted parsers are fast enough for a few hundred places.
z.config({ jitless: true });

export const ZOD_JITLESS = true;
