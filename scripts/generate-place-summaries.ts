// Writes a short summary of each place with Claude, once, for the place sheets in the web app.
// Run with `pnpm summaries:generate` (ANTHROPIC_API_KEY in the environment). Add `--only=<id>,<id>`
// to write only those places again, keeping the rest of the file.
//
// In:  data/italy.json, through the planner's normalizer, so the model sees the same fields the
//      page shows. Each call gets one place's own listing and nothing else (summarySource in
//      apps/web/lib/placeSummaryCheck.ts).
// Out: apps/web/lib/placeSummaries.data.json: each summary that passed the check, and the places
//      left out with the check's reasons, each row with the model, the prompt version and the
//      date that wrote it, so a partial run never relabels rows it did not write.
//
// Every answer goes through the code check in apps/web/lib/placeSummaryCheck.ts. A rejected
// summary is asked for once more, with the reasons; a second rejection leaves the place out, and
// its sheet shows no summary. The unit tests run the same check over the saved file.
//
// Decision: a call that fails (a revoked key, no network, an overloaded API) is not a verdict on
// the place. The place keeps the row it had, the run names it and exits 1, and
// `--only=<its id>` writes it once the API answers. Saving it as left out would wipe a good
// summary while every test stayed green.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { buildDataset, type Place } from "@italy/planner";
import {
  checkSummary,
  MAX_SUMMARY_CHARS,
  type SummaryProblem,
  summaryInput,
  summarySource,
} from "../apps/web/lib/placeSummaryCheck";

const DATA_PATH = fileURLToPath(new URL("../data/italy.json", import.meta.url));
const OUT_PATH = fileURLToPath(
  new URL("../apps/web/lib/placeSummaries.data.json", import.meta.url),
);

export const MODEL = "claude-opus-5-5";
// v2 keeps the listing's advice as advice and every quality on the thing the listing gives it to.
export const PROMPT_VERSION = "place-summary-v2";
// Decision: room for the JSON answer and the little thinking this model does at low effort.
// Claude Opus 5.5 cannot turn thinking off (a 400), so effort "low" is the lever that keeps a
// two-sentence answer short and cheap; an answer cut off by the limit counts as a failed try.
const MAX_TOKENS = 2000;
const CONCURRENCY = 4;

const SYSTEM_PROMPT = `You write a short summary of one place for a trip planner. The user message is the place's listing as JSON. The page shows the summary labelled "Summary by AI, from the listing", above the listing's own description and a list of facts (hours, price, rating, visit length).

Write one or two plain sentences, at most ${MAX_SUMMARY_CHARS - 20} characters in all, that say what a visit to the place is like.

Rules:
- Use only what the listing says. Add no facts: no history, no people, no places, no numbers, no dates, days, seasons, times of day, prices, tickets, booking, queues or meals, unless the listing's own words state them.
- The listing's advice to its reader (book, order, dress, rent, arrange, take, go, split the cost) stays advice. Never state it as what the place is, includes or does: "booking a small-group class makes the difference" does not make the class small-group, and "tours are easy to arrange" does not mean a tour is included. Leave advice out rather than turn it into a fact.
- Nothing is included, served, run or provided unless the listing says so. Where the listing says a visitor can do something there ("you can drink it for almost nothing at the cantina"), say that it can be done there, not that the visit includes it.
- Keep each quality with the thing the listing gives it to. Views the listing gives the hill are the hill's, not its gardens'. A tag describes the place itself, never its neighbourhood or anything else. Add no quality (quiet, relaxed and the like) the listing and its tags do not state.
- Leave out the hours, price, rating and visit length; the page shows them.
- Name nothing the listing does not name. Italy and Italian are fine.
- No superlatives (best, most, top, finest, oldest and the like) unless the listing uses that word.
- Third person. Never address the reader: no "you" or "your", and no commands. No "we", "our" or "I".
- Write whole sentences, each with a verb. Start each sentence with the place's name, "The", "A", "An", "It", "Its" or "This".
- No dashes as punctuation, no exclamation marks, no emoji. Calm, plain words, no marketing.

Answer with JSON: {"summary": "..."}`;

const OUTPUT_SCHEMA = {
  type: "object",
  properties: { summary: { type: "string" } },
  required: ["summary"],
  additionalProperties: false,
} as const;

/** Who wrote a row: the model, the prompt version and the day, on every row of the file. */
interface Written {
  model: string;
  promptVersion: string;
  writtenOn: string; // YYYY-MM-DD
}

/** One saved summary. `attempts` is 2 when the first answer failed the check. */
interface SavedSummary extends Written {
  placeId: string;
  text: string;
  attempts: 1 | 2;
}

/** A place whose answers failed the check twice, with the check's reasons. */
interface LeftOut extends Written {
  placeId: string;
  reasons: string[];
}

/** apps/web/lib/placeSummaries.data.json, each list sorted by place id. */
interface SummaryFile {
  summaries: SavedSummary[];
  leftOut: LeftOut[];
}

/** What one place's run came to: a summary, left out, or a call that failed. */
export type PlaceResult =
  | { placeId: string; text: string; attempts: 1 | 2 }
  | { placeId: string; reasons: string[] }
  | { placeId: string; callFailed: string };

type Attempt =
  | { ok: true; text: string }
  | { ok: false; reasons: string[]; raw: string }
  | { ok: false; callFailed: string };

/** The summary from the model's JSON answer, or null when the answer is not that shape. */
export function parseAnswer(raw: string): string | null {
  try {
    const value = JSON.parse(raw) as unknown;
    if (value && typeof value === "object" && "summary" in value) {
      const summary = (value as { summary: unknown }).summary;
      return typeof summary === "string" ? summary.trim() : null;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * The file after a run: each place this run answered gets its new row, labelled with this run;
 * every other place, and each place whose call failed, keeps the row it had.
 */
export function mergeRun(
  previous: SummaryFile | null,
  results: readonly PlaceResult[],
  written: Written,
): SummaryFile {
  const answered = new Set(
    results.filter((result) => !("callFailed" in result)).map((result) => result.placeId),
  );
  const summaries = (previous?.summaries ?? []).filter((row) => !answered.has(row.placeId));
  const leftOut = (previous?.leftOut ?? []).filter((row) => !answered.has(row.placeId));
  for (const result of results) {
    if ("text" in result) summaries.push({ ...result, ...written });
    else if ("reasons" in result) leftOut.push({ ...result, ...written });
  }
  const byId = (a: { placeId: string }, b: { placeId: string }) =>
    a.placeId < b.placeId ? -1 : a.placeId > b.placeId ? 1 : 0;
  return { summaries: summaries.sort(byId), leftOut: leftOut.sort(byId) };
}

/** An answer the model gave but that cannot be used: a refusal, or cut off by the limit. */
class UnusableAnswer extends Error {}

function textOf(message: Anthropic.Message): string {
  for (const block of message.content) if (block.type === "text") return block.text;
  return "";
}

async function ask(client: Anthropic, messages: Anthropic.MessageParam[]): Promise<string> {
  const message = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages,
    output_config: {
      effort: "low",
      format: { type: "json_schema", schema: OUTPUT_SCHEMA as unknown as Record<string, unknown> },
    },
  });
  if (message.stop_reason === "refusal") throw new UnusableAnswer("The model declined.");
  if (message.stop_reason === "max_tokens") throw new UnusableAnswer("The answer was cut off.");
  return textOf(message);
}

/** One try: the answer, checked, or the error when the call itself failed. */
async function attempt(
  client: Anthropic,
  place: Place,
  messages: Anthropic.MessageParam[],
): Promise<Attempt> {
  let raw: string;
  try {
    raw = await ask(client, messages);
  } catch (error) {
    // Decision: a refusal or a cut-off answer is the model's answer, so the retry applies;
    // anything else failed the call, not the check, and the place keeps its row.
    const message = (error as Error).message;
    if (error instanceof UnusableAnswer) return { ok: false, reasons: [message], raw: "" };
    return { ok: false, callFailed: message };
  }
  const text = parseAnswer(raw);
  if (text === null) return { ok: false, reasons: ["The answer was not the JSON asked for."], raw };
  const problems: SummaryProblem[] = checkSummary(text, summarySource(place));
  if (problems.length > 0) return { ok: false, reasons: problems.map((p) => p.detail), raw };
  return { ok: true, text };
}

async function summarize(client: Anthropic, place: Place): Promise<PlaceResult> {
  const listing = JSON.stringify(summaryInput(summarySource(place)), null, 2);
  const first: Anthropic.MessageParam = { role: "user", content: listing };
  const one = await attempt(client, place, [first]);
  if (one.ok) return { placeId: place.id, text: one.text, attempts: 1 };
  if ("callFailed" in one) return { placeId: place.id, callFailed: one.callFailed };
  console.log(`${place.id} ${place.name}: retrying (${one.reasons.join(" ")})`);
  const two = await attempt(client, place, [
    first,
    // The API rejects an empty text block, so an empty answer goes back as "{}".
    { role: "assistant", content: one.raw || "{}" },
    {
      role: "user",
      content: `That summary was rejected: ${one.reasons.join(" ")} Write it again, following every rule.`,
    },
  ]);
  if (two.ok) return { placeId: place.id, text: two.text, attempts: 2 };
  if ("callFailed" in two) return { placeId: place.id, callFailed: two.callFailed };
  return { placeId: place.id, reasons: [...one.reasons, ...two.reasons] };
}

/** Runs `work` over `items`, `limit` at a time, keeping the input order in the result. */
async function pool<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

function readPrevious(): SummaryFile | null {
  try {
    return JSON.parse(readFileSync(OUT_PATH, "utf8")) as SummaryFile;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("Set ANTHROPIC_API_KEY to run this script.");
    process.exit(1);
  }
  const only = process.argv
    .find((arg) => arg.startsWith("--only="))
    ?.slice("--only=".length)
    .split(",")
    .filter(Boolean);
  const { places } = buildDataset(JSON.parse(readFileSync(DATA_PATH, "utf8")));
  const chosen = only ? places.filter((place) => only.includes(place.id)) : places;
  const client = new Anthropic();
  const results = await pool(chosen, CONCURRENCY, (place) => summarize(client, place));

  const written = {
    model: MODEL,
    promptVersion: PROMPT_VERSION,
    writtenOn: new Date().toISOString().slice(0, 10),
  };
  const file = mergeRun(readPrevious(), results, written);
  writeFileSync(OUT_PATH, `${JSON.stringify(file, null, 2)}\n`);
  const count = (attempts: 1 | 2) =>
    results.filter((result) => "attempts" in result && result.attempts === attempts).length;
  const leftOut = results.filter((result) => "reasons" in result).length;
  const failed = results.filter((result) => "callFailed" in result);
  console.log(
    `${chosen.length} places: ${count(1)} passed first time, ${count(2)} passed on the retry, ${leftOut} left out, ${failed.length} not answered. Wrote ${OUT_PATH}`,
  );
  if (failed.length > 0) {
    for (const result of failed) {
      if ("callFailed" in result) console.error(`${result.placeId}: ${result.callFailed}`);
    }
    console.error(
      `The call failed for ${failed.length} places; each kept its previous row. Run again with --only=${failed.map((result) => result.placeId).join(",")}`,
    );
    process.exitCode = 1;
  }
}

if (import.meta.main) await main();
