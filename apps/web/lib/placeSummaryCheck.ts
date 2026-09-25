import type { Place } from "@italy/planner";
import { typeWord } from "./format";

// The code check every AI summary of a place must pass before it is saved, and again in CI over
// the saved file (test/placeSummaries.test.ts), so a hand edit cannot slip past it. The model
// writes one or two sentences from the place's own listing; this check refuses any that says
// more than the listing does in a way code can see: a number, time, date, price, booking claim,
// meal, name or superlative the listing does not have, or anything outside the house voice (no
// "you", no "we", no dashes, no exclamation marks, and each sentence opened by a plain word or the
// place's own name, so the listing's instructions cannot come through as commands). It checks
// words, not meaning: "so go early" in mid-sentence, or a name written in lower case, passes. The
// prompt asks for the rest and a person reads the results; what code can check, it checks.
//
// scripts/generate-place-summaries.ts sends the model exactly `summarySource(place)` and checks
// against the same fields, so the model and the check see one listing.

/** Longest summary, in characters. The place sheet shows it whole, with no "more" link. */
export const MAX_SUMMARY_CHARS = 220;

/** The fields of one place the model sees: its listing, nothing from any other place. */
export interface SummarySource {
  name: string;
  type: string; // "Historic site"
  city: string;
  region: string; // not sent to the model; only allows the region's name in a summary
  neighbourhood: string | null;
  description: string;
  tags: string[];
  typicalVisitMinutes: number;
  priceLevel: number | null; // 1 to 4
  rating: number | null; // 0 to 5
  hours: string | null; // the listing's hours text, as written
}

export function summarySource(place: Place): SummarySource {
  return {
    name: place.name,
    type: typeWord(place.type),
    city: place.city,
    region: place.region,
    neighbourhood: place.neighborhood,
    description: place.description.trim(),
    tags: place.tags,
    typicalVisitMinutes: place.durationMin,
    priceLevel: place.priceLevel,
    rating: place.rating,
    hours: place.hoursRaw?.trim() || null,
  };
}

/** The listing as the model receives it (JSON in the user turn). The region is left out. */
export function summaryInput(source: SummarySource): Omit<SummarySource, "region"> {
  const { region: _region, ...input } = source;
  return input;
}

export type SummaryProblemKind =
  | "empty"
  | "length"
  | "sentences"
  | "second_person"
  | "first_person"
  | "dash"
  | "exclamation"
  | "emoji"
  | "number"
  | "time"
  | "date"
  | "price"
  | "booking"
  | "meal"
  | "superlative"
  | "proper_noun"
  | "sentence_start";

export interface SummaryProblem {
  kind: SummaryProblemKind;
  detail: string; // a plain sentence, sent back to the model on the retry
}

// ---------- Word lists ----------

const NUMBER_WORDS = [
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
  "twenty",
  "thirty",
  "forty",
  "fifty",
  "sixty",
  "seventy",
  "eighty",
  "ninety",
  "hundred",
  "thousand",
  "million",
  "billion",
  "zero",
  "dozen",
  "couple",
  "pair",
  "single",
  "double",
  "triple",
  "half",
  "twice",
  "first",
  "second",
  "third",
  "fourth",
  "fifth",
  "sixth",
  "seventh",
  "eighth",
  "ninth",
  "tenth",
  "eleventh",
  "twelfth",
  "thirteenth",
  "fourteenth",
  "fifteenth",
  "sixteenth",
  "seventeenth",
  "eighteenth",
  "nineteenth",
  "twentieth",
];

const TIME_WORDS = [
  "am",
  "pm",
  "noon",
  "midnight",
  "midday",
  "o'clock",
  "hour",
  "minute",
  "morning",
  "afternoon",
  "evening",
  "night",
  "nightly",
  "overnight",
  "sunrise",
  "sunset",
  "dawn",
  "dusk",
  "daytime",
  "today",
  "tonight",
  "tomorrow",
];

const DATE_WORDS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
  "weekend",
  "weekday",
  "daily",
  "weekly",
  "monthly",
  "annual",
  "annually",
  "yearly",
  "year",
  "year-round",
  "decade",
  "century",
  "centuries",
  "millennium",
  "summer",
  "winter",
  "autumn",
  "springtime",
  "season",
  "seasonal",
  "holiday",
  "january",
  "february",
  "march",
  "april",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

const PRICE_WORDS = [
  "euro",
  "cheap",
  "cheaper",
  "inexpensive",
  "expensive",
  "pricey",
  "affordable",
  "budget",
  "free",
  "cost",
  "costly",
  "price",
  "priced",
  "splurge",
  "bargain",
  "fee",
  "ticket",
  "ticketed",
  "paid",
  "value",
];

const BOOKING_WORDS = [
  "book",
  "booking",
  "booked",
  "pre-book",
  "prebook",
  "reserve",
  "reserved",
  "reservation",
  "queue",
  "queues",
  "advance",
  "ahead",
  "waitlist",
];

// Decision: selling out is caught as the phrase. "Sell" and "sold" alone are plain trade ("the
// stands sell suppli", "what supermarkets sell"), which two saved summaries say truly.
const SELL_OUT = /\b(?:sells?|selling|sold)[\s-]+out\b/i;

const MEAL_WORDS = ["breakfast", "brunch", "lunch", "dinner", "supper", "aperitivo"];

const SUPERLATIVES = [
  "best",
  "worst",
  "most",
  "least",
  "top",
  "unmissable",
  "must-see",
  "world-class",
  "unrivalled",
  "unrivaled",
  "unparalleled",
  "unbeatable",
];

/** Words ending in -est that are not superlatives. */
const NOT_SUPERLATIVE = new Set([
  "arrest",
  "attest",
  "chest",
  "contest",
  "crest",
  "digest",
  "earnest",
  "forest",
  "guest",
  "harvest",
  "honest",
  "interest",
  "invest",
  "lest",
  "manifest",
  "modest",
  "nest",
  "pest",
  "protest",
  "quest",
  "request",
  "rest",
  "suggest",
  "test",
  "unrest",
  "vest",
  "west",
  "zest",
]);

// Decision: every sentence starts with one of these plain openers or a word of the place's name,
// type, city, region or neighbourhood, never any other word of the listing. A sentence-initial
// capital is otherwise the one place a name the listing does not have ("Bernini designed...")
// could pass the proper noun check, and the listings are full of instructions ("Go early", "Book
// ahead", "Order the Negroni") that would address the reader without a "you". The prompt asks for
// these openers, so a good summary meets it the first time.
const SENTENCE_STARTS = new Set([
  "a",
  "an",
  "the",
  "it",
  "its",
  "it's",
  "this",
  "these",
  "that",
  "those",
  "there",
  "here",
  "inside",
  "outside",
  "beyond",
  "behind",
  "along",
  "around",
  "above",
  "below",
  "within",
  "from",
  "in",
  "on",
  "at",
  "by",
  "with",
  "for",
  "once",
  "both",
  "each",
  "every",
  "many",
  "some",
  "visitors",
  "visits",
  "guests",
  "diners",
]);

/** Names always allowed besides the place's own city and region. */
const ALWAYS_ALLOWED_NAMES = new Set(["italy", "italian"]);

// ---------- Text helpers ----------

/** Lower case, apostrophes straightened, so "Rome's" and "rome’s" compare alike. */
function fold(text: string): string {
  return text.toLowerCase().replaceAll("’", "'");
}

/** The words of a text, lower case, possessives dropped: "Rome's river" gives rome, river. */
function wordsOf(text: string): string[] {
  const words = fold(text).match(/[\p{L}\p{M}][\p{L}\p{M}'-]*/gu) ?? [];
  return words.map((word) => word.replace(/'s$/, "").replace(/'$/, ""));
}

/** Words whose -ing is not an ending: "evening" is not "even" done, "morning" not "morn". */
const NOT_INFLECTED = new Set([
  "evening",
  "morning",
  "during",
  "ceiling",
  "nothing",
  "something",
  "anything",
  "everything",
]);

/**
 * The root of a word, so its forms compare alike: plurals ("evenings", "centuries"), -ed and -ing
 * ("booked", "booking" and "Book" all give "book"; "reserved" and "reserve" give "reserv"), a
 * doubled last consonant ("stopped") and a final e. Both sides of every comparison go through it,
 * so a root only has to be the same for the same word, not a real word.
 */
function stem(word: string): string {
  let root = word;
  if (root.length > 4 && root.endsWith("ies")) root = `${root.slice(0, -3)}y`;
  else if (root.length > 3 && root.endsWith("s") && !root.endsWith("ss")) root = root.slice(0, -1);
  if (NOT_INFLECTED.has(root)) return root;
  const vowel = (text: string) => /[aeiouy]/.test(text);
  if (root.length > 5 && root.endsWith("ing") && vowel(root.slice(0, -3))) {
    root = root.slice(0, -3);
  } else if (
    root.length > 4 &&
    root.endsWith("ed") &&
    !root.endsWith("eed") &&
    vowel(root.slice(0, -2))
  ) {
    root = root.slice(0, -2);
  } else {
    return root.length > 3 && root.endsWith("e") && !root.endsWith("ee") ? root.slice(0, -1) : root;
  }
  if (/([bdgmnprt])\1$/.test(root)) root = root.slice(0, -1);
  return root.length > 3 && root.endsWith("e") && !root.endsWith("ee") ? root.slice(0, -1) : root;
}

/** Every word of a text, and each part of a hyphenated word, as roots. */
function sourceWords(text: string): Set<string> {
  const set = new Set<string>();
  for (const word of wordsOf(text)) {
    set.add(stem(word));
    for (const part of word.split("-")) if (part) set.add(stem(part));
  }
  return set;
}

/** Digits as they appear: "9", "19:00", "4.8", "1,500". */
function numbersOf(text: string): string[] {
  return text.match(/\d+(?:[.,:]\d+)*/g) ?? [];
}

/** The listing as one text: every field's value, none of the field names. */
function listingText(source: SummarySource): string {
  return [
    source.name,
    source.type,
    source.city,
    source.region,
    source.neighbourhood ?? "",
    source.description,
    source.tags.join(" "),
    source.tags.map((tag) => tag.replaceAll("-", " ")).join(" "),
    source.hours ?? "",
  ].join("\n");
}

// Decision: a number may only come from the listing's own words (its name, description and
// hours). The visit length, price level and rating are numbers too, but they are the page's facts,
// not the listing's text, and a summary that borrowed them ("2 underground levels" from price
// level 2, "120 arches" from a 120 minute visit) would state something nobody wrote.
/** The listing's words that may carry a number: its name, description and hours text. */
function numberText(source: SummarySource): string {
  return [source.name, source.description, source.hours ?? ""].join("\n");
}

/** The words a sentence may start with besides the plain openers. */
function startText(source: SummarySource): string {
  return [source.name, source.type, source.city, source.region, source.neighbourhood ?? ""].join(
    "\n",
  );
}

/** The sentences of the summary, split after a full stop, question mark or exclamation mark, not after "St.". */
function sentencesOf(text: string): string[] {
  return text
    .split(/(?<!\b(?:St|Sts|Mt|Mr|Mrs|Ms|Dr)\.)(?<=[.?!])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== "");
}

function quoteList(words: Iterable<string>): string {
  return [...new Set(words)].map((word) => `"${word}"`).join(", ");
}

// ---------- The check ----------

/** Every problem with a summary of the place, or [] when it may be shown. */
export function checkSummary(summary: string, source: SummarySource): SummaryProblem[] {
  const text = summary.trim();
  if (text === "") return [{ kind: "empty", detail: "The summary is empty." }];
  const problems: SummaryProblem[] = [];
  const add = (kind: SummaryProblemKind, detail: string) => problems.push({ kind, detail });

  const length = [...text].length;
  if (length > MAX_SUMMARY_CHARS) {
    add("length", `It is ${length} characters; the limit is ${MAX_SUMMARY_CHARS}.`);
  }
  const sentences = sentencesOf(text);
  if (sentences.length > 2) add("sentences", `It has ${sentences.length} sentences; write 1 or 2.`);
  if (/\b(you|your|yours|yourself|yourselves)\b|\byou'/i.test(text.replaceAll("’", "'"))) {
    add("second_person", 'It addresses the reader ("you" or "your"). Write in the third person.');
  }
  if (/\b(we|our|ours|us|i|me|my)\b/i.test(text)) {
    add("first_person", 'It speaks as "we" or "I". Write in the third person.');
  }
  if (/[‒-―]|\s-\s|--/.test(text)) {
    add("dash", "It uses a dash as punctuation. Use a comma or a full stop instead.");
  }
  if (text.includes("!")) add("exclamation", "It has an exclamation mark.");
  if (/\p{Extended_Pictographic}/u.test(text)) add("emoji", "It has an emoji.");

  const listing = listingText(source);
  const listed = sourceWords(listing);
  const inListing = (word: string) => listed.has(stem(word));

  const numbers = new Set(numbersOf(numberText(source)));
  const newNumbers = numbersOf(text).filter((number) => !numbers.has(number));
  if (newNumbers.length > 0) {
    add("number", `It has ${quoteList(newNumbers)}, which the listing does not.`);
  }
  const words = wordsOf(text);
  const pieces = words.flatMap((word) => [word, ...(word.includes("-") ? word.split("-") : [])]);
  const unlisted = (list: readonly string[]) => {
    const roots = new Set(list.map(stem));
    return pieces
      .filter((word) => list.includes(word) || roots.has(stem(word)))
      .filter((word) => !inListing(word));
  };
  const lists: [SummaryProblemKind, readonly string[], string][] = [
    ["number", NUMBER_WORDS, "a number"],
    ["time", TIME_WORDS, "a time"],
    ["date", DATE_WORDS, "a day, date or season"],
    ["price", PRICE_WORDS, "a price or cost"],
    ["booking", BOOKING_WORDS, "booking, selling out or queues"],
    ["meal", MEAL_WORDS, "a meal"],
  ];
  const sellOut = SELL_OUT.test(listing)
    ? []
    : (text.match(new RegExp(SELL_OUT.source, "gi")) ?? []);
  for (const [kind, list, what] of lists) {
    const found = [...unlisted(list), ...(kind === "booking" ? sellOut : [])];
    if (found.length > 0) {
      add(kind, `It mentions ${what} (${quoteList(found)}) that the listing does not state.`);
    }
  }
  if (/[€$£]/.test(text) && !/[€$£]/.test(listing)) {
    add("price", "It has a currency sign the listing does not have.");
  }

  const superlatives = pieces.filter(
    (word) =>
      !inListing(word) &&
      (SUPERLATIVES.includes(word) || (/^[a-z]{3,}est$/.test(word) && !NOT_SUPERLATIVE.has(word))),
  );
  if (superlatives.length > 0) {
    add("superlative", `It uses ${quoteList(superlatives)}, which the listing does not.`);
  }

  const names = new Set([...ALWAYS_ALLOWED_NAMES, ...wordsOf(`${source.city} ${source.region}`)]);
  const starts = sourceWords(startText(source));
  const newNames: string[] = [];
  const badStarts: string[] = [];
  for (const sentence of sentences) {
    const tokens = sentence.match(/[\p{L}\p{M}][\p{L}\p{M}'’-]*/gu) ?? [];
    tokens.forEach((token, index) => {
      const word = fold(token).replace(/'s$/, "").replace(/'$/, "");
      if (index === 0) {
        if (!SENTENCE_STARTS.has(word) && !starts.has(stem(word))) badStarts.push(token);
        return;
      }
      for (const part of token.split(/-/)) {
        if (!/^\p{Lu}/u.test(part)) continue;
        const folded = fold(part).replace(/'s$/, "").replace(/'$/, "");
        if (!names.has(folded) && !inListing(folded)) newNames.push(part);
      }
    });
  }
  if (newNames.length > 0) {
    add("proper_noun", `It names ${quoteList(newNames)}, which the listing does not.`);
  }
  if (badStarts.length > 0) {
    add(
      "sentence_start",
      `A sentence starts with ${quoteList(badStarts)}. Start each sentence with the place's name, "The", "A", "An", "It", "Its" or "This".`,
    );
  }
  return problems;
}
