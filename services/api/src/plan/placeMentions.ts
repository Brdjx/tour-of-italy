import { normalizeWords, type PlannerContext } from "@italy/planner";

// The dataset-aware check only the API runs: whether model text uses a proper noun the dataset
// never mentions (an invented place such as "the Eiffel Tower in Paris"). Which places a text
// names is the planner's namesPlaceOutside, which the page also runs on the summary after an edit.

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

const lexicons = new WeakMap<PlannerContext, Set<string>>();

/** Every normalized word the dataset uses, plus a few safe extras. */
function knownWords(ctx: PlannerContext): Set<string> {
  const known = lexicons.get(ctx);
  if (known) return known;
  const words = new Set(EXTRA_WORDS.split(" "));
  const addWords = (text: string | null) => {
    for (const word of normalizeWords(text ?? "").split(" ")) if (word) words.add(word);
  };
  for (const place of ctx.places) {
    for (const text of [place.name, place.city, place.region, place.neighborhood]) addWords(text);
    addWords(place.description);
    addWords(place.tags.join(" "));
  }
  for (const anchor of ctx.anchors) addWords(`${anchor.name} ${anchor.region}`);
  lexicons.set(ctx, words);
  return words;
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
  const words = knownWords(ctx);
  for (const sentence of text.split(/(?<=[.!?:;])\s+/)) {
    const found = unknownInSentence(sentence, words);
    if (found !== null) return found;
  }
  return null;
}
