import type { LlmClient, LlmResult, SelectInput } from "@italy/api/llm/client";
import { LlmError } from "@italy/api/llm/errors";
import { PROMPT_VERSION } from "@italy/api/llm/prompt";
import { describe, expect, it } from "vitest";
import { errorRecord, RecordingClient } from "../src/clients";
import { PATHS } from "../src/paths";
import { RECORDING_FORMAT, type Recording } from "../src/recording";
import { writeRecording } from "../src/recordingStore";
import { Scrubber } from "../src/scrub";
import { CASES, filesUnder, tempDir } from "./helpers";

// Failure vector F4: an API key or a secret header must never reach an eval recording, a results
// file, or the repository. A fake key is planted in every place one could leak from, and every
// file that reaches disk is scanned for it.

const FAKE_KEY = "sk-ant-test-FAKE-0123456789abcdef";
const LEAKS = [/sk-ant-test-FAKE/, /x-api-key/i];

function expectClean(dir: string) {
  const files = filesUnder(dir);
  expect(files.length).toBeGreaterThan(0);
  for (const { path, text } of files) {
    for (const leak of LEAKS) expect(leak.test(text), `${path} matches ${leak}`).toBe(false);
  }
}

const signal = new AbortController().signal;
const input = {
  request: CASES[0]?.request,
  system: "s",
  user: "u",
  timeoutMs: 1000,
  signal,
} as SelectInput;

function recordingOf(call: RecordingClient["calls"][number], attempt: number): Recording {
  return {
    format: RECORDING_FORMAT,
    kind: "live",
    caseId: "rome-food-balanced",
    run: 1,
    attempt,
    model: "claude-sonnet-5",
    promptVersion: PROMPT_VERSION,
    recordedAt: "2026-09-24T12:00:00.000Z",
    candidateHash: `sha256:${"0".repeat(64)}`,
    request: CASES.find((c) => c.id === "rome-food-balanced")?.request as Recording["request"],
    ...call,
  };
}

describe("scrubber", () => {
  const scrubber = new Scrubber([FAKE_KEY]);

  it("removes a planted key, a bearer token, and header lines from text", () => {
    const text = `401: invalid x-api-key: ${FAKE_KEY}; Authorization: Bearer abc.def; also sk-ant-api03-other`;
    const out = scrubber.text(text);
    expect(out).not.toContain(FAKE_KEY);
    expect(out).not.toMatch(/x-api-key|Bearer abc|sk-ant-/i);
    expect(scrubber.findings(out)).toEqual([]);
  });

  it("removes a secret header name even when no value follows it", () => {
    const out = new Scrubber().text("401: the x-api-key header is missing (X-Api-Key)");
    expect(out).not.toMatch(/x-api-key/i);
  });

  it("leaves ordinary text, however long, exactly as it was", () => {
    const long = `${"A quiet morning walk. ".repeat(200)}Enjoy.`;
    expect(scrubber.text(long)).toBe(long);
  });

  it("removes a bearer token after an Authorization header, not only the word Bearer", () => {
    const out = new Scrubber().text("401: Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.body.sig");
    expect(out).not.toMatch(/eyJ|body\.sig|Bearer/);
  });

  it("removes a header's value along with its name, even when the value is not key-shaped", () => {
    const out = new Scrubber().text("forbidden: x-origin-verify: 7fQ2origin9secret");
    expect(out).not.toContain("7fQ2origin9secret");
  });

  it("keeps ordinary words in a recorded answer, so the replay parses what the model wrote", () => {
    const answer = `{"summary":"Authorization: none needed; the bearer of the pass skips the line."}`;
    expect(scrubber.value({ rawText: answer })).toEqual({ rawText: answer });
    expect(scrubber.findings(answer)).toEqual([]);
    // The same words in an error message are treated as a header line and removed.
    expect(scrubber.text(answer)).not.toContain("Authorization: none");
  });

  it("still removes a key and a secret header name from a recorded answer", () => {
    const answer = `{"summary":"use ${FAKE_KEY} in x-api-key"}`;
    const out = scrubber.value({ rawText: answer }).rawText;
    expect(out).not.toMatch(/sk-ant-|x-api-key/i);
    expect(scrubber.findings(out)).toEqual([]);
  });

  it("drops header and key fields from objects, at any depth", () => {
    const out = scrubber.value({
      a: { headers: { "x-api-key": FAKE_KEY }, apiKey: FAKE_KEY, keep: "ok" },
    });
    expect(out).toEqual({ a: { keep: "ok" } });
  });

  it("refuses to write text that still holds a secret", () => {
    expect(() => scrubber.assertClean(`{"k":"${FAKE_KEY}"}`, "file.json")).toThrow(
      /Refusing to write file.json/,
    );
    expect(() => new Scrubber().assertClean("x-api-key", "file.json")).toThrow(/header name/);
  });
});

describe("recordings on disk", () => {
  it("keeps a planted key and x-api-key header out of a failed call's recording", async () => {
    const leaking = new LlmError("auth", `Model API rejected the key ${FAKE_KEY}`, {
      status: 401,
      detail: { type: "authentication_error", apiMessage: `invalid x-api-key: ${FAKE_KEY}` },
      cause: Object.assign(new Error(FAKE_KEY), { headers: { "x-api-key": FAKE_KEY } }),
    });
    const inner: LlmClient = {
      model: "claude-sonnet-5",
      select: () => Promise.reject(leaking),
      repair: () => Promise.reject(new TypeError(`fetch failed for x-api-key=${FAKE_KEY}`)),
    };
    const scrubber = new Scrubber([FAKE_KEY]);
    const client = new RecordingClient(inner, scrubber);
    await expect(client.select(input)).rejects.toBe(leaking);
    await expect(
      client.repair({ ...input, previousText: "", violations: [], repairMessage: "" }),
    ).rejects.toThrow();
    const dir = tempDir();
    client.calls.forEach((call, i) => {
      writeRecording(dir, recordingOf(call, i + 1), scrubber);
    });
    expectClean(dir);
    expect(client.calls[0]?.error).toMatchObject({ kind: "auth", status: 401 });
  });

  it("keeps a key the model echoed out of the recorded answer", async () => {
    const result: LlmResult = {
      selection: null,
      rawText: `{"summary":"my key is ${FAKE_KEY}, header x-api-key: ${FAKE_KEY}"}`,
      schemaIssues: [],
      usage: { inputTokens: 1, outputTokens: 1 },
      latencyMs: 5,
      model: "claude-sonnet-5",
      stopReason: "end_turn",
    };
    const inner: LlmClient = { model: "m", select: async () => result, repair: async () => result };
    const client = new RecordingClient(inner, new Scrubber([FAKE_KEY]));
    await client.select(input);
    const dir = tempDir();
    // A scrubber that was never told the key still removes it by its shape.
    writeRecording(
      dir,
      recordingOf(client.calls[0] as RecordingClient["calls"][number], 1),
      new Scrubber(),
    );
    expectClean(dir);
  });

  it("describes an error by kind, status, and scrubbed message only", () => {
    const error = new LlmError("rate_limited", "Model API rate limit", {
      status: 429,
      retryAfterMs: 2000,
    });
    expect(errorRecord(error, new Scrubber())).toEqual({
      kind: "rate_limited",
      status: 429,
      retryAfterMs: 2000,
      message: "Model API rate limit",
    });
    expect(errorRecord("boom", new Scrubber())).toEqual({
      kind: "unknown",
      message: "string: boom",
    });
  });

  it("has no key, bearer token, or secret header in any committed recording", () => {
    const scrubber = new Scrubber();
    for (const { path, text } of filesUnder(PATHS.recordings)) {
      expect(scrubber.findings(text), path).toEqual([]);
      expect(/authorization|anthropic-version/i.test(text), path).toBe(false);
    }
  });
});
