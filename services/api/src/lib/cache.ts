import { createHash } from "node:crypto";
import { planRequestKey, type TripRequest } from "@italy/planner";

// A small in-memory LRU cache, per Lambda instance: the first layer of the AI plan cache
// (plan/planCache.ts). Entries are stored and returned as deep copies, so a caller that edits a
// returned plan can never change what the next caller gets.

export class LruCache<V> {
  readonly #entries = new Map<string, V>();
  readonly #max: number;

  constructor(maxEntries: number) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError("An LRU cache needs room for at least one entry");
    }
    this.#max = maxEntries;
  }

  /** A copy of the entry, marked most recently used, or undefined. */
  get(key: string): V | undefined {
    const value = this.#entries.get(key);
    if (value === undefined) return undefined;
    this.#entries.delete(key);
    this.#entries.set(key, value);
    return structuredClone(value);
  }

  /** Stores a copy; drops the least recently used entry when full. */
  set(key: string, value: V): void {
    this.#entries.delete(key);
    this.#entries.set(key, structuredClone(value));
    while (this.#entries.size > this.#max) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }

  /** Removes the entry, if there is one. */
  delete(key: string): void {
    this.#entries.delete(key);
  }

  get size(): number {
    return this.#entries.size;
  }
}

/** Plans cached per instance. */
export const PLAN_CACHE_ENTRIES = 100;

/**
 * The cache key for a plan: SHA-256 of the prompt version, the model client's identity (model id,
 * or the fixture scenario), the deployed commit, the place data's fingerprint, and the request's
 * key (planRequestKey in the planner, which the page's in-tab cache uses too). A prompt, model,
 * code or data change never serves a plan made under the old one.
 */
// Decision: the commit is part of the key. The table keeps plans across deploys, and a cached
// plan is served without the planner, the validator or the text checks running again, so a
// deploy that fixes or tightens one of them would otherwise keep serving plans made without it
// for up to 7 days. A deploy starts the shared cache empty, as it always did each instance's.
export function planCacheKey(parts: {
  promptVersion: string;
  model: string;
  codeVersion: string; // GIT_SHA
  dataVersion: string;
  request: TripRequest;
}): string {
  const text = [
    parts.promptVersion,
    parts.model,
    parts.codeVersion,
    parts.dataVersion,
    planRequestKey(parts.request),
  ].join("\n");
  return createHash("sha256").update(text).digest("hex");
}
