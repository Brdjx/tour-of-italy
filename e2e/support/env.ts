// Ports, URLs and fixed values shared by the Playwright config and the tests.

export const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 14390);
export const API_PORT = Number(process.env.E2E_API_PORT ?? 18790);
export const LOCAL_URL = `http://127.0.0.1:${WEB_PORT}`;

/** Set by the post-deploy job: the smoke tests then run against that site and nothing starts. */
export const REMOTE_URL = process.env.E2E_BASE_URL?.trim().replace(/\/+$/, "") || null;

// Decision: every local test runs with the browser clock starting at one fixed instant in Rome.
// The form's default start date is two weeks after "today", and a date's weekday and season
// decide which places are open, so a real clock would give a different plan every day and a
// failure could not be reproduced the next morning. Time still flows from this instant.
export const FIXED_NOW = new Date("2026-10-01T08:00:00+02:00");
export const TIME_ZONE = "Europe/Rome";
/** The form's default start date under FIXED_NOW (DEFAULT_START_OFFSET_DAYS is 14). */
export const DEFAULT_START_DATE = "2026-10-15";
