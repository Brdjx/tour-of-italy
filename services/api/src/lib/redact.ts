// Scrubs secrets out of anything headed for a log line. Two layers: patterns that look like keys
// (so a key we never registered is still caught), and exact values registered at runtime (the
// Anthropic key and the origin secret, once loaded from SSM).

const REDACTED = "[redacted]";

/** Longest string kept in a log field; longer text is cut so one field cannot flood a line. */
const MAX_STRING_CHARS = 2000;

/** Deepest nesting walked; anything deeper is replaced, so a cyclic or huge object is safe. */
const MAX_DEPTH = 8;

// Decision: patterns, not only exact values. A key pasted into a request body or an SDK error
// message would otherwise reach CloudWatch before anything registered it.
const SECRET_PATTERNS: readonly RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]+/g, // Anthropic API and admin keys
  /\bsk-[A-Za-z0-9_-]{16,}/g, // other provider-style secret keys
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, // bearer tokens
  /\bA(?:KIA|SIA)[A-Z0-9]{16}\b/g, // AWS access key ids
];

/** Field names whose values are never logged, whatever they contain. */
const SECRET_KEYS =
  /^(?:authorization|cookie|set-cookie|x-api-key|x-origin-verify|api[-_]?key|apikey|secret|password)$/i;

/** Registered secrets shorter than this are ignored: redacting "a" would destroy every line. */
const MIN_SECRET_CHARS = 8;

export class Redactor {
  readonly #secrets = new Set<string>();

  /** Registers an exact value to redact from now on. Short or empty values are ignored. */
  addSecret(value: string | null | undefined): void {
    if (typeof value === "string" && value.length >= MIN_SECRET_CHARS) this.#secrets.add(value);
  }

  /** The text with every registered secret and key-like pattern replaced. */
  text(value: string): string {
    let out = value;
    for (const secret of this.#secrets) out = out.split(secret).join(REDACTED);
    for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, REDACTED);
    return out.length > MAX_STRING_CHARS ? `${out.slice(0, MAX_STRING_CHARS)}...` : out;
  }

  /** A JSON-safe copy of `value` with secrets redacted. Never throws. */
  value(value: unknown): unknown {
    return this.#walk(value, 0, new WeakSet());
  }

  #walk(value: unknown, depth: number, seen: WeakSet<object>): unknown {
    if (typeof value === "string") return this.text(value);
    if (value === null || typeof value !== "object") return scalar(value);
    if (depth >= MAX_DEPTH || seen.has(value)) return "[truncated]";
    seen.add(value);
    if (value instanceof Error) return this.#error(value, depth, seen);
    if (Array.isArray(value)) return value.map((item) => this.#walk(item, depth + 1, seen));
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = SECRET_KEYS.test(key) ? REDACTED : this.#walk(item, depth + 1, seen);
    }
    return out;
  }

  // Decision: errors keep name, message, and stack (redacted) in logs, which only operators read.
  // Response bodies never carry any of them; see lib/httpErrors.ts.
  #error(error: Error, depth: number, seen: WeakSet<object>): Record<string, unknown> {
    const out: Record<string, unknown> = { name: error.name, message: this.text(error.message) };
    if (error.stack) out.stack = this.text(error.stack);
    if (error.cause !== undefined) out.cause = this.#walk(error.cause, depth + 1, seen);
    return out;
  }
}

function scalar(value: unknown): unknown {
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol") return `[${typeof value}]`;
  return value; // boolean, undefined
}
