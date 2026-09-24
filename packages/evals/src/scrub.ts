// Keeps secrets out of eval recordings and results (failure vector F4). Three layers, each enough
// on its own for the cases it covers:
//   1. recordings are built from named fields only (never an error object or response headers);
//   2. every string is scrubbed: registered secret values, key-shaped text, and header lines;
//   3. the finished file text is checked once more, and the write is refused if anything is left.

const REDACTED = "[redacted]";

// Decision: the eval keeps its own copy of the key patterns instead of using the API's Redactor.
// The Redactor cuts strings at 2,000 characters to keep log lines short, which would corrupt a
// recorded model answer, and it does not remove header names written inside text.
/** Key-shaped values: removed from every string, and never allowed in a written file. */
const KEY_PATTERNS: readonly RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]+/g, // Anthropic API and admin keys
  /\bsk-[A-Za-z0-9_-]{16,}/g, // other provider-style secret keys
  /\bA(?:KIA|SIA)[A-Z0-9]{16}\b/g, // AWS access key ids
];

/** A bearer token. Runs before HEADER_LINE, which would otherwise eat "Bearer" and leave the token. */
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;

/** A header written as text ("x-api-key: ...", "Authorization=Bearer ..."), name and value. */
const HEADER_LINE =
  /\b(?:x-api-key|anthropic-api-key|x-origin-verify|authorization|proxy-authorization)\b["']?\s*[:=]\s*["']?[^\s"',;}]*/gi;

/** Header names that never belong in a recording, even without a value. */
const HEADER_NAMES = /\b(?:x-api-key|anthropic-api-key|x-origin-verify)\b/gi;

/** Object keys whose values are never kept, whatever they hold. */
const SECRET_KEYS =
  /^(?:headers?|authorization|cookie|set-cookie|x-api-key|api[-_]?key|apikey|secret|password|token)$/i;

/** Fields that hold the model's own text, which only loses what is secret (see modelText). */
const MODEL_TEXT_KEYS: ReadonlySet<string> = new Set(["rawText"]);

/** Registered secrets shorter than this are ignored: redacting "a" would destroy every string. */
const MIN_SECRET_CHARS = 8;

export class Scrubber {
  readonly #secrets: string[];

  /** `secrets` are exact values to remove, such as the API key the run used. */
  constructor(secrets: readonly (string | undefined)[] = []) {
    this.#secrets = secrets.filter(
      (s): s is string => typeof s === "string" && s.length >= MIN_SECRET_CHARS,
    );
  }

  /** Registered secrets and key-shaped values replaced: what no string may ever keep. */
  #keys(value: string): string {
    let out = value;
    for (const secret of this.#secrets) out = out.split(secret).join(REDACTED);
    for (const pattern of KEY_PATTERNS) out = out.replace(pattern, REDACTED);
    return out;
  }

  /**
   * Model text with registered secrets, key-shaped values, and secret header names replaced.
   * Nothing else changes: the replay parses this text as the model's answer.
   */
  // Decision: "Authorization" and "bearer" are ordinary words a model may write ("the bearer of
  // the pass"), so the header-line and bearer patterns are kept for error messages and other
  // text. A key the model echoes is still caught as a registered secret or by its shape.
  modelText(value: string): string {
    return this.#keys(value).replace(HEADER_NAMES, REDACTED);
  }

  /** Any other text (error messages above all): bearer tokens and header lines go as well. */
  text(value: string): string {
    // Order matters: the bearer token before the header line (which would take only the word
    // "Bearer"), and whole header lines before bare header names (which would orphan the value).
    return this.#keys(value)
      .replace(BEARER, REDACTED)
      .replace(HEADER_LINE, REDACTED)
      .replace(HEADER_NAMES, REDACTED);
  }

  /** A JSON-safe copy with every string scrubbed and secret-named fields dropped. */
  value<T>(value: T): T {
    return this.#walk(value) as T;
  }

  #walk(value: unknown): unknown {
    if (typeof value === "string") return this.text(value);
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map((item) => this.#walk(item));
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (SECRET_KEYS.test(key)) continue;
      const modelText = MODEL_TEXT_KEYS.has(key) && typeof item === "string";
      out[key] = modelText ? this.modelText(item) : this.#walk(item);
    }
    return out;
  }

  /**
   * What in `text` still looks secret, or an empty list when it is clean. It looks only for what
   * both modes remove from every string, so a scrubbed file always passes and anything found is
   * a real leak.
   */
  findings(text: string): string[] {
    const found: string[] = [];
    for (const secret of this.#secrets)
      if (text.includes(secret)) found.push("a registered secret");
    for (const pattern of KEY_PATTERNS) {
      if (new RegExp(pattern.source, pattern.flags).test(text)) found.push("a key-shaped value");
    }
    if (new RegExp(HEADER_NAMES.source, "i").test(text)) found.push("a secret header name");
    return found;
  }

  /** Throws when `text` still holds anything secret. Called on every file before it is written. */
  assertClean(text: string, where: string): void {
    const found = this.findings(text);
    if (found.length > 0) {
      throw new Error(`Refusing to write ${where}: it contains ${[...new Set(found)].join(", ")}`);
    }
  }
}
