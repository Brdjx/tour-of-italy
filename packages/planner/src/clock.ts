// Clock times as minutes from local midnight: parsing the data's hour texts and formatting
// times for the traveler. Re-exported from time.ts with the calendar helpers.

const MINUTES_PER_DAY = 1440;
const CLOCK_PATTERN = /^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?$/i;

/**
 * Parses "9:30", "09.30", "9", "24:00", "9am", "12:30pm" into minutes from midnight.
 * Returns null for anything else, including "25:00", "9:60", and "13pm".
 */
export function parseClock(text: string): number | null {
  const match = CLOCK_PATTERN.exec(text.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = match[2] === undefined ? 0 : Number(match[2]);
  const suffix = match[3]?.toLowerCase();
  if (minute > 59) return null;
  if (suffix) {
    if (hour < 1 || hour > 12) return null;
    const hour24 = (hour % 12) + (suffix === "pm" ? 12 : 0); // 12am = 0, 12pm = 12
    return hour24 * 60 + minute;
  }
  if (hour > 24 || (hour === 24 && minute !== 0)) return null;
  return hour * 60 + minute;
}

/**
 * Formats minutes from midnight as "HH:MM". 1440 is "24:00" (closing at midnight); later values
 * wrap to the next day, so 1500 is "01:00". Throws RangeError for negative or non-finite input.
 */
export function formatClock(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes < 0) {
    throw new RangeError(`formatClock needs a non-negative number of minutes, got ${minutes}`);
  }
  const rounded = Math.round(minutes);
  const clock = rounded === MINUTES_PER_DAY ? MINUTES_PER_DAY : rounded % MINUTES_PER_DAY;
  const hours = Math.floor(clock / 60);
  const mins = clock % 60;
  return `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;
}
