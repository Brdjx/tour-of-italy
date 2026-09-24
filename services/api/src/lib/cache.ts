import { createHash } from "node:crypto";

// A small in-memory LRU cache for AI plans, per Lambda instance. Entries are stored and returned
// as deep copies, so a caller that edits a returned plan can never change what the next caller
// gets.

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

  get size(): number {
    return this.#entries.size;
  }
}

/** Plans cached per instance. */
export const PLAN_CACHE_ENTRIES = 100;

/**
 * JSON with object keys sorted at every level, so two requests that differ only in key order
 * share a cache key. Array order is kept: it can matter to the plan.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value)) ?? "null";
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = sortKeys((value as Record<string, unknown>)[key]);
  }
  return out;
}

/**
 * The cache key for a plan: SHA-256 of the prompt version, the model client's identity (model id,
 * or the fixture scenario), and the canonical request. A prompt or model change never serves a
 * plan made under the old one.
 */
export function planCacheKey(parts: {
  promptVersion: string;
  model: string;
  request: unknown;
}): string {
  const text = [parts.promptVersion, parts.model, canonicalJson(parts.request)].join("\n");
  return createHash("sha256").update(text).digest("hex");
}
