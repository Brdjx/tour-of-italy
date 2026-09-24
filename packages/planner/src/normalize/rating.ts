import { MIN_SUGGEST_RATING, RATING_TEN_POINT_MAX } from "../config";
import type { DataIssue, Normalized } from "../types";
import { makeIssue } from "./issue";

// Ratings on a 0..5 scale. Values up to 10 are read as a 10-point scale and halved; anything else
// unusable becomes null. Low ratings are kept but flagged, and the planner never suggests them.

/** Normalizes rating. Pure; never throws. */
export function normalizeRating(
  raw: unknown,
  context: { placeId: string },
): Normalized<number | null> {
  const target = { placeId: context.placeId, field: "rating" };
  const issues: DataIssue[] = [];
  if (raw === null || raw === undefined) {
    return {
      value: null,
      issues: [makeIssue(target, "rating_missing", raw ?? null, "No rating", "Treated as unrated")],
    };
  }
  let rating: number | null = typeof raw === "number" ? raw : null;
  if (typeof raw === "string") {
    const parsed = raw.trim() === "" ? Number.NaN : Number(raw.trim());
    rating = Number.isFinite(parsed) ? parsed : null;
    const action = rating === null ? "Treated as unrated" : `Read as ${rating}`;
    issues.push(makeIssue(target, "rating_format", raw, "Rating given as text", action));
  } else if (rating === null) {
    issues.push(
      makeIssue(target, "rating_format", raw, "Rating is not a number", "Treated as unrated"),
    );
  }
  if (rating === null) return { value: null, issues };

  if (!Number.isFinite(rating) || rating < 0 || rating > RATING_TEN_POINT_MAX) {
    const detail = `Rating ${raw} is outside 0 to 5`;
    issues.push(makeIssue(target, "rating_out_of_range", raw, detail, "Treated as unrated"));
    return { value: null, issues };
  }
  if (rating > 5) {
    const halved = Math.round((rating / 2) * 10) / 10;
    const detail = `Rating ${rating} looks like a 10-point scale`;
    issues.push(makeIssue(target, "rating_rescaled", raw, detail, `Halved to ${halved}`));
    rating = halved;
  }
  if (rating < MIN_SUGGEST_RATING) {
    const detail = `Rated ${rating}, below ${MIN_SUGGEST_RATING}`;
    const action = "Kept, but never suggested unless the traveler asks for it";
    issues.push(makeIssue(target, "low_rating", raw, detail, action));
  }
  return { value: rating, issues };
}
