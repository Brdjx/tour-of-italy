import type { PlannerContext } from "@italy/planner";
import { normalizeWords } from "./textGuards";

// The dataset-aware text checks: which places a piece of model text names (by full name or by a
// common short form), and whether it uses a proper noun the dataset never mentions (an invented
// place such as "the Eiffel Tower in Paris").

interface Lexicon {
  forms: Map<string, string[]>; // place id -> normalized name forms that count as naming it
  words: Set<string>; // every normalized word the dataset uses, plus a few safe extras
}

// Decision: a short form must have two words or six letters, so a qualifier such as "(Exterior)"
// or a one-word stub never counts as a place name. Full names always count.
function isUsableForm(normal: string): boolean {
  return normal.split(" ").length >= 2 || normal.length >= 6;
}

/**
 * Name forms that count as naming a place: the full name, the part before the first comma
 * ("Ferrari Museum"), the part before a parenthesis ("Accademia Gallery"), a parenthetical of two
 * or more words ("Villa Borghese"), and each without a leading "the" ("Last Supper").
 */
export function nameForms(name: string): string[] {
  const forms = new Set<string>();
  const full = normalizeWords(name);
  if (full.length >= 3) forms.add(full);
  const shorter = [name.split(",")[0] ?? "", name.split("(")[0] ?? ""];
  for (const match of name.matchAll(/\(([^)]*)\)/g)) {
    const inner = normalizeWords(match[1] ?? "");
    if (inner.split(" ").length >= 2) shorter.push(inner);
  }
  for (const text of shorter) {
    const normal = normalizeWords(text);
    if (isUsableForm(normal)) forms.add(normal);
  }
  for (const form of [...forms]) {
    const rest = form.replace(/^the /, "");
    if (rest !== form && isUsableForm(rest)) forms.add(rest);
  }
  return [...forms];
}

// Capitalized words that are fine without appearing in the data: the country, days, and months.
const EXTRA_WORDS =
  "i italy italian italians day days monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september october november december";

// Decision: common openers that are not in the data. A sentence may start "Enjoy Rome's piazzas"
// even though "enjoy" never appears in a description.
const SENTENCE_OPENERS = new Set(
  "enjoy begin finish stroll discover explore head finally spend savor admire relax catch pair follow soak sample unwind round expect wander".split(
    " ",
  ),
);

const lexicons = new WeakMap<PlannerContext, Lexicon>();

function lexiconFor(ctx: PlannerContext): Lexicon {
  const known = lexicons.get(ctx);
  if (known) return known;
  const forms = new Map<string, string[]>();
  const words = new Set(EXTRA_WORDS.split(" "));
  const addWords = (text: string | null) => {
    for (const word of normalizeWords(text ?? "").split(" ")) if (word) words.add(word);
  };
  for (const place of ctx.places) {
    forms.set(place.id, nameForms(place.name));
    for (const text of [place.name, place.city, place.region, place.neighborhood]) addWords(text);
    addWords(place.description);
    addWords(place.tags.join(" "));
  }
  for (const anchor of ctx.anchors) addWords(`${anchor.name} ${anchor.region}`);
  const lexicon = { forms, words };
  lexicons.set(ctx, lexicon);
  return lexicon;
}

const containsWords = (outer: string, inner: string) => ` ${outer} `.includes(` ${inner} `);

/**
 * True when the text names a dataset place outside `allowed`. A name that is part of an allowed
 * place's own name does not count: "Trevi Fountain" inside "Trevi Fountain by Night".
 */
export function namesPlaceOutside(
  text: string,
  allowed: ReadonlySet<string>,
  ctx: PlannerContext,
): boolean {
  const { forms } = lexiconFor(ctx);
  const haystack = normalizeWords(text);
  const allowedForms = [...allowed].flatMap((id) => forms.get(id) ?? []);
  for (const [id, placeForms] of forms) {
    if (allowed.has(id)) continue;
    for (const form of placeForms) {
      if (!containsWords(haystack, form)) continue;
      if (!allowedForms.some((own) => containsWords(own, form))) return true;
    }
  }
  return false;
}

const isCapitalized = (token: string) => /^\p{Lu}/u.test(token);

function unknownInSentence(sentence: string, words: ReadonlySet<string>): string | null {
  const tokens = [...sentence.matchAll(/[\p{L}\p{N}'’-]+/gu)].map((match) => match[0]);
  const known = (token: string) =>
    normalizeWords(token)
      .split(" ")
      .every((word) => word === "" || words.has(word));
  for (const [index, token] of tokens.entries()) {
    if (!isCapitalized(token)) continue;
    if (index === 0) {
      const startsRun = isCapitalized(tokens[1] ?? "");
      if (!startsRun || SENTENCE_OPENERS.has(normalizeWords(token))) continue;
    }
    if (!known(token)) return token;
  }
  return null;
}

/**
 * The first capitalized word the dataset never uses, or null. The first word of each sentence is
 * skipped (capitalized by grammar), unless it starts a run of capitalized words ("Eiffel Tower").
 */
export function unknownProperNoun(text: string, ctx: PlannerContext): string | null {
  const { words } = lexiconFor(ctx);
  for (const sentence of text.split(/(?<=[.!?:;])\s+/)) {
    const found = unknownInSentence(sentence, words);
    if (found !== null) return found;
  }
  return null;
}
