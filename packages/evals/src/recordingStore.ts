import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { formatJson, writeJson } from "./jsonFile";
import {
  type Recording,
  type RecordingKind,
  RecordingSchema,
  recordingFileName,
  recordingFolder,
} from "./recording";
import type { Scrubber } from "./scrub";

// Reading and writing recording files. Every write goes through the scrubber and a final check of
// the file text, so a secret cannot reach disk even if a caller forgets to scrub.

function jsonFilesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsonFilesUnder(path));
    else if (entry.name.endsWith(".json")) out.push(path);
  }
  return out.sort();
}

/** Every recording under `dir`, validated. A file that does not parse stops the run with its path. */
export function readRecordings(dir: string): Recording[] {
  return jsonFilesUnder(dir).map((path) => {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      throw new Error(`${relative(dir, path)}: not valid JSON (${(error as Error).message})`);
    }
    const parsed = RecordingSchema.safeParse(raw);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
      throw new Error(`${relative(dir, path)}: invalid recording\n  ${issues.join("\n  ")}`);
    }
    return parsed.data;
  });
}

/** Where a recording lives under `dir`. */
export function recordingPath(dir: string, recording: Recording): string {
  const folder = recordingFolder(recording.kind, recording.model, recording.promptVersion);
  return join(dir, folder, recordingFileName(recording));
}

/** A recording scrubbed and checked, with where it goes. Nothing is written yet. */
interface PreparedRecording {
  path: string;
  clean: Recording;
}

function prepareRecording(
  dir: string,
  recording: Recording,
  scrubber: Scrubber,
): PreparedRecording {
  const clean = RecordingSchema.parse(scrubber.value(recording));
  const path = recordingPath(dir, clean);
  scrubber.assertClean(formatJson(clean), relative(dir, path));
  return { path, clean };
}

/** Scrubs, checks, and writes one recording. Returns the path written. */
export function writeRecording(dir: string, recording: Recording, scrubber: Scrubber): string {
  const { path, clean } = prepareRecording(dir, recording, scrubber);
  writeJson(path, clean);
  return path;
}

type Target = { kind: RecordingKind; model: string; promptVersion: string };

/**
 * Deletes the recordings of the given cases for one kind, model, and prompt version.
 */
// Decision: a new run replaces a case's recordings instead of adding to them. Otherwise a run
// that needed one attempt would leave the previous run's attempt 2 beside it, and replay would
// feed a repair answer that never belonged to this run. Only files of the target's kind match,
// so clearing live recordings can never delete an offline set, whatever the folder.
export function clearRecordings(dir: string, target: Target, caseIds: readonly string[]): number {
  const folder = join(dir, recordingFolder(target.kind, target.model, target.promptVersion));
  if (!existsSync(folder)) return 0;
  const suffix = target.kind === "live" ? "" : `\\.${target.kind}`;
  const pattern = new RegExp(`^(.+)-(\\d+)-(\\d+)${suffix}\\.json$`);
  let removed = 0;
  for (const name of readdirSync(folder)) {
    const caseId = pattern.exec(name)?.[1];
    if (caseId === undefined || !caseIds.includes(caseId)) continue;
    rmSync(join(folder, name));
    removed++;
  }
  return removed;
}

/**
 * Replaces one case's recordings with a finished set. Every new file is scrubbed and checked
 * before anything is deleted, so a refused write leaves the previous recordings in place.
 */
export function replaceCaseRecordings(
  dir: string,
  target: Target,
  caseId: string,
  recordings: readonly Recording[],
  scrubber: Scrubber,
): number {
  const prepared = recordings.map((r) => prepareRecording(dir, r, scrubber));
  clearRecordings(dir, target, [caseId]);
  for (const { path, clean } of prepared) writeJson(path, clean);
  return prepared.length;
}
