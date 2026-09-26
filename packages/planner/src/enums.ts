// Runtime lists behind the union types in types.ts. The Zod schemas use these arrays, and
// types.ts derives each union from them, so a value added here reaches types, schemas, and the
// API in one edit.

export const PLACE_TYPES = [
  "historic_site",
  "restaurant",
  "experience",
  "museum",
  "viewpoint",
  "cafe",
  "neighborhood",
  "market",
  "park",
  "shop",
  "other",
] as const;

/** Why a record is left out of planning. Every excluded record carries one. */
export const EXCLUSION_REASONS = [
  "invalid_record", // not an object
  "missing_name", // no usable name
  "no_location", // no usable coordinates and nothing to estimate from
  "duplicate", // same name and city as a more complete record
  "closed", // the hours or a note say the place is shut
] as const;

export const ISSUE_KINDS = [
  "dataset_shape",
  "record_invalid",
  "id_missing",
  "id_duplicate",
  "duplicate_place",
  "name_missing",
  "name_variant",
  "city_missing",
  "city_variant",
  "region_missing",
  "region_variant",
  "neighborhood_missing",
  "neighborhood_corrected",
  "description_missing",
  "type_variant",
  "type_unknown",
  "tags_missing",
  "tag_variant",
  "tag_invalid",
  "hours_missing",
  "hours_open_access",
  "hours_free_text",
  "hours_name_hint",
  "hours_unparsed",
  "hours_past_midnight",
  "hours_conflict",
  "place_closed",
  "season_restriction",
  "date_restriction",
  "note_not_applied",
  "note_unread",
  "note_info",
  "booking_missing",
  "booking_invalid",
  "duration_missing",
  "duration_invalid",
  "duration_format",
  "duration_out_of_bounds",
  "duration_exceeds_hours",
  "meal_unavailable",
  "price_missing",
  "price_format",
  "price_unparsed",
  "price_conflict",
  "rating_missing",
  "rating_format",
  "rating_rescaled",
  "rating_out_of_range",
  "low_rating",
  "coords_missing",
  "coords_format",
  "coords_swapped",
  "coords_out_of_bounds",
  "coords_far_from_city",
  "coords_unrepairable",
  "shared_location",
  "same_experience",
] as const;

export const PACES = ["relaxed", "balanced", "packed"] as const;

export const PLAN_SOURCES = ["ai", "ai_repaired", "deterministic"] as const;

export const FALLBACK_REASONS = [
  "no_key", // no API key configured
  "disabled", // AI layer switched off by config
  "requested", // caller asked for the rules-only planner (?mode=deterministic)
  "timeout", // a model call or the overall deadline ran out
  "schema_invalid", // model output did not match the schema, and no repair was possible
  "invalid_after_repair", // model output still failed validation after the repair turn
  "refusal", // the model declined (stop_reason "refusal")
  "max_tokens", // model output was cut off
  "rate_limited", // 429 or 529 overloaded
  "llm_error", // any other SDK, network, or unexpected error
  "offline", // the browser planned locally because the API was unreachable
] as const;

export const VIOLATION_CODES = [
  "WRONG_DAY_COUNT", // error: not TRIP_DAYS days
  "WRONG_DATE", // error: a day's date is not startDate plus its index
  "UNKNOWN_ANCHOR", // error: day base is not a known base
  "TOO_MANY_ANCHORS", // error: more distinct bases than the validator allows (validate.ts)
  "UNKNOWN_PLACE", // error: place id not in the dataset
  "DUPLICATE_PLACE", // error: same place twice in the trip
  "EXCLUDED_PLACE", // error: place the traveler excluded
  "EMPTY_DAY", // error: a day with no stops
  "INVALID_TIME", // error: a stop's times are not a valid range or do not match its visit length
  "CLOSED_AT_TIME", // error: visit falls outside the open ranges on that date
  "SEASONAL_CLOSED", // error: closed on that date by a season or date rule
  "OVERLAP", // error: stops overlap once travel and buffer are included
  "WRONG_TRAVEL", // error: a day's transfer or a stop's travel time does not match the travel model
  "OUTSIDE_DAY_WINDOW", // error: stop outside the pace's day window
  "OUTSIDE_ANCHOR", // error: place does not belong to the day's base
  "TOO_MANY_VISITS", // error: more non-meal stops than the pace allows
  "MEAL_OUTSIDE_WINDOW", // error: a lunch or dinner starts outside its meal window
  "NOT_A_MEAL_PLACE", // error: a lunch or dinner stop at a place that does not serve meals
  "MUST_INCLUDE_MISSING", // error: a placeable must-include is missing
  "MUST_INCLUDE_UNPLACEABLE", // warning: a must-include cannot fit any day, with the reason
  "HOURS_UNKNOWN", // warning: scheduled place has unknown hours on that date
  "OVER_BUDGET", // warning: place above the chosen price level
  "MEAL_MISSING", // warning: no lunch or dinner on a day
  "LONG_TRANSFER", // warning: day starts with a transfer over LONG_TRANSFER_MIN
  "SAME_LOCATION", // warning: two places at the same coordinates in one trip
  "LOW_RATING", // warning: place rated below MIN_SUGGEST_RATING (only via edits or must-include)
  "ANCHOR_NOT_CHOSEN", // warning: a day's base is not one of the bases the traveler chose
] as const;
