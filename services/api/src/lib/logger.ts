import { Redactor } from "./redact";

// Structured logging: one JSON object per line, which CloudWatch Logs Insights can query. Every
// field passes through the redactor, so a caller can log an error or a request fragment without
// first proving it holds no secret.

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  /** Registers a secret value (API key, origin secret) to redact from every later line. */
  addSecret(value: string | null | undefined): void;
}

export interface LoggerOptions {
  level?: LogLevel; // lines below this level are dropped
  sink?: (line: string) => void; // where lines go; stdout by default
  now?: () => number; // clock for the time field
  redactor?: Redactor; // shared redactor, so several loggers see the same secrets
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Longest traveler note kept in a log line. */
export const NOTES_LOG_CHARS = 80;

export function createLogger(options: LoggerOptions = {}): Logger {
  const minimum = LEVEL_ORDER[options.level ?? "info"];
  const sink = options.sink ?? ((line: string) => process.stdout.write(`${line}\n`));
  const now = options.now ?? Date.now;
  const redactor = options.redactor ?? new Redactor();

  const write = (level: LogLevel, event: string, fields: LogFields = {}): void => {
    if (LEVEL_ORDER[level] < minimum) return;
    const body = redactor.value(fields) as LogFields;
    const record = { level, time: new Date(now()).toISOString(), event, ...body };
    try {
      sink(JSON.stringify(record));
    } catch {
      // Decision: a failing sink must never fail the request that is being logged.
    }
  };

  return {
    debug: (event, fields) => write("debug", event, fields),
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields),
    addSecret: (value) => redactor.addSecret(value),
  };
}

/** A logger that drops everything, for tests that do not look at logs. */
export function silentLogger(): Logger {
  return createLogger({ sink: () => {} });
}

/** Traveler notes as logged: control characters removed and cut to NOTES_LOG_CHARS. */
export function notesForLog(notes: string | undefined): string | undefined {
  if (notes === undefined) return undefined;
  const clean = notes.replace(/[\p{Cc}\p{Cf}]+/gu, " ").trim();
  return clean.length > NOTES_LOG_CHARS ? `${clean.slice(0, NOTES_LOG_CHARS)}...` : clean;
}
