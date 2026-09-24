import { formatClock } from "../lib/format";

/**
 * "09:40" with tabular digits but a normal-width colon. The font's tabular figures also widen
 * the colon, which reads "09 : 40"; the colon opts out with .clock-colon (timetable.css).
 */
export function ClockText({ minutes }: { minutes: number }) {
  const [hours, mins] = formatClock(minutes).split(":");
  if (mins === undefined) return <>{hours}</>;
  return (
    <>
      {hours}
      <span className="clock-colon">:</span>
      {mins}
    </>
  );
}
