import { describe, expect, it } from "vitest";
import { createLogger, NOTES_LOG_CHARS, notesForLog } from "../../src/lib/logger";
import { Redactor } from "../../src/lib/redact";

// Failure vector F4: a secret in a log line. CloudWatch is readable by more people than the key
// should be, so every line is scrubbed before it is written.

const FAKE_KEY = "sk-ant-test-FAKE-0123456789abcdefghij";
const ORIGIN_SECRET = "origin-secret-value-4f7c2a9e1b";

function capture(level: "debug" | "info" = "debug") {
  const lines: string[] = [];
  const logger = createLogger({ level, sink: (line) => lines.push(line), now: () => 0 });
  return { logger, lines };
}

describe("logger redaction", () => {
  it("never writes an Anthropic key, even one nobody registered", () => {
    const { logger, lines } = capture();

    logger.info("request", { note: `my key is ${FAKE_KEY}`, nested: { deep: [FAKE_KEY] } });

    expect(lines.join("\n")).not.toContain(FAKE_KEY);
    expect(lines.join("\n")).not.toContain("sk-ant-");
    expect(lines[0]).toContain("[redacted]");
  });

  it("never writes a registered secret such as the origin secret", () => {
    const { logger, lines } = capture();
    logger.addSecret(ORIGIN_SECRET);

    logger.warn("mismatch", { header: ORIGIN_SECRET, text: `got ${ORIGIN_SECRET}!` });

    expect(lines.join("\n")).not.toContain(ORIGIN_SECRET);
  });

  it("never writes a secret carried inside an error message, stack, or cause", () => {
    const { logger, lines } = capture();
    const cause = new Error(`inner ${FAKE_KEY}`);
    const error = new Error(`outer ${FAKE_KEY}`, { cause });

    logger.error("boom", { error });

    const line = lines.join("\n");
    expect(line).not.toContain(FAKE_KEY);
    expect(line).toContain("outer [redacted]");
  });

  it("drops values under secret-looking field names whatever they contain", () => {
    const { logger, lines } = capture();

    logger.info("headers", { authorization: "Basic abc", "x-origin-verify": "plain", apiKey: "x" });

    const record = JSON.parse(lines[0] ?? "{}");
    expect(record.authorization).toBe("[redacted]");
    expect(record["x-origin-verify"]).toBe("[redacted]");
    expect(record.apiKey).toBe("[redacted]");
  });

  it("keeps token counts, which only look like secrets by name", () => {
    const { logger, lines } = capture();

    logger.info("plan", { usage: { inputTokens: 1200, outputTokens: 300 } });

    expect(JSON.parse(lines[0] ?? "{}").usage).toEqual({ inputTokens: 1200, outputTokens: 300 });
  });

  it("ignores very short registered secrets instead of redacting every line", () => {
    const redactor = new Redactor();
    redactor.addSecret("a");
    redactor.addSecret("");
    redactor.addSecret(undefined);

    expect(redactor.text("a plan")).toBe("a plan");
  });

  it("survives cyclic objects and huge strings without throwing", () => {
    const { logger, lines } = capture();
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;

    logger.info("odd", {
      cyclic,
      huge: "x".repeat(10_000),
      big: 10n,
      fn: () => 1,
      nan: Number.NaN,
    });

    const record = JSON.parse(lines[0] ?? "{}");
    expect(record.cyclic.self).toBe("[truncated]");
    expect(record.huge.length).toBeLessThan(2100);
    expect(record.big).toBe("10");
    expect(record.nan).toBe("NaN");
  });

  it("writes one JSON object per line with level, time, and event", () => {
    const { logger, lines } = capture();

    logger.info("request", { status: 200 });

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      level: "info",
      time: "1970-01-01T00:00:00.000Z",
      event: "request",
      status: 200,
    });
  });

  it("drops lines below the configured level", () => {
    const { logger, lines } = capture("info");

    logger.debug("noise");
    logger.info("kept");

    expect(lines).toHaveLength(1);
  });

  it("never fails the request when the sink throws", () => {
    const logger = createLogger({
      sink: () => {
        throw new Error("disk full");
      },
    });

    expect(() => logger.error("request", { status: 500 })).not.toThrow();
  });
});

describe("notesForLog", () => {
  it(`cuts traveler notes to ${NOTES_LOG_CHARS} characters so logs never hold whole notes`, () => {
    const notes = "a".repeat(500);

    expect(notesForLog(notes)?.length).toBe(NOTES_LOG_CHARS + 3);
    expect(notesForLog(undefined)).toBeUndefined();
  });

  it("strips control characters that could forge log lines", () => {
    expect(notesForLog('line one\n{"level":"error"}\u0000')).toBe('line one {"level":"error"}');
  });
});
