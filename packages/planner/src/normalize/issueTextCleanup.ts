import { RATING_TEN_POINT_MAX } from "../config";
import type { IssueKind } from "../types";

// Second part of the issue text table (see issueText.ts): booking, travel notes, and clean-up
// of ids, names, types, tags, ratings, and coordinates. Shown after the first part.

export const CLEANUP_ISSUE_TEXT = {
  booking_missing: {
    title: "Booking not stated",
    explanation: "The source does not say whether booking is needed.",
  },
  booking_invalid: {
    title: "Booking value not readable",
    explanation: "The booking value is not yes or no, so it is treated as not stated.",
  },
  note_info: {
    title: "Travel notes",
    explanation:
      "Seasonal tips and booking advice from the source are shown with the place. They do not change opening hours.",
  },
  duplicate_place: {
    title: "Duplicate listings merged",
    explanation: "Two listings with the same name in the same city were merged into one.",
  },
  id_missing: {
    title: "Missing ids",
    explanation: "Listings without a usable id were given one based on city and name.",
  },
  id_duplicate: {
    title: "Repeated ids",
    explanation: "Listings that shared an id were given distinct ids.",
  },
  name_missing: {
    title: "Listings without a name",
    explanation: "A listing without a name cannot be shown, so it is left out.",
  },
  name_variant: {
    title: "Names cleaned up",
    explanation: "Extra spaces or hidden characters were removed from names.",
  },
  city_missing: {
    title: "Missing city",
    explanation: "The city is taken from the nearest listed place.",
  },
  city_variant: {
    title: "City names standardized",
    explanation: "Italian or differently written city names were mapped to one English name.",
  },
  region_missing: {
    title: "Missing region",
    explanation: "The region is taken from other places in the same city.",
  },
  region_variant: {
    title: "Region names standardized",
    explanation: "Italian or differently written region names were mapped to one English name.",
  },
  neighborhood_missing: {
    title: "No neighborhood listed",
    explanation: "The city is shown instead of a neighborhood.",
  },
  neighborhood_corrected: {
    title: "Neighborhood corrected",
    explanation:
      "The listed neighborhood does not match where the place is, so a reviewed correction is shown instead.",
  },
  description_missing: {
    title: "No description",
    explanation: "The place is shown without a description.",
  },
  type_variant: {
    title: "Place types standardized",
    explanation: "Differently written types were mapped to a known type.",
  },
  type_unknown: {
    title: "Unknown place types",
    explanation: 'Types that are not recognized are shown as "other" with a typical visit length.',
  },
  tags_missing: {
    title: "No tags",
    explanation: "The listing has no usable tag list, so it matches no interests.",
  },
  tag_variant: {
    title: "Tags standardized",
    explanation:
      'Tags were written in one style, for example "local_favorite" became "local-favorite".',
  },
  tag_invalid: { title: "Unusable tags", explanation: "Empty or non-text tags were dropped." },
  rating_missing: { title: "No rating", explanation: "Unrated places are scored as average." },
  rating_format: {
    title: "Rating given as text",
    explanation: "Ratings written as text were converted, or treated as unrated when not a number.",
  },
  rating_rescaled: {
    title: "Rating on a 10-point scale",
    explanation: `Ratings above 5 were read as out of ${RATING_TEN_POINT_MAX} and scaled to 5.`,
  },
  rating_out_of_range: {
    title: "Rating out of range",
    explanation: `Ratings outside 0 to ${RATING_TEN_POINT_MAX} are treated as unrated.`,
  },
  coords_format: {
    title: "Coordinates given as text",
    explanation: "Coordinates written as text were converted to numbers.",
  },
  record_invalid: {
    title: "Unreadable listings",
    explanation: "Entries that are not listings at all are left out.",
  },
  dataset_shape: {
    title: "Unexpected file layout",
    explanation: "The data file was not a plain list of places.",
  },
} satisfies Partial<Record<IssueKind, { title: string; explanation: string }>>;
