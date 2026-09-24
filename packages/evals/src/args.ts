import { RECORDING_KINDS } from "./recording";

// Command-line options for `pnpm eval`: --model <id>, --runs <n>, --case <filter>[,<filter>...].
// Both "--flag value" and "--flag=value" work; --case may repeat.

export const USAGE =
  "Usage: pnpm eval [--model <model id>] [--runs <1 to 10>] [--case <id part>[,<id part>...]]";

export const DEFAULT_MODEL = "claude-sonnet-5";
export const DEFAULT_RUNS = 3;
export const MAX_RUNS = 10; // the same cap the eval workflow applies

export interface EvalArgs {
  model: string;
  runs: number;
  cases: string[]; // case id filters; empty means every case
}

export class UsageError extends Error {
  override name = "UsageError";
}

const MODEL_ID = /^[a-z0-9][a-z0-9._-]{0,99}$/;

// Decision: the offline sets live in folders named after their kind, and a live run's folder is
// its model id, so these two ids are refused: a run under either would replace committed files.
const RESERVED_IDS: ReadonlySet<string> = new Set(
  RECORDING_KINDS.filter((kind) => kind !== "live"),
);

function splitFlag(
  arg: string,
  next: string | undefined,
): { name: string; value?: string; used: number } {
  const eq = arg.indexOf("=");
  if (eq > 0) return { name: arg.slice(0, eq), value: arg.slice(eq + 1), used: 1 };
  return { name: arg, value: next, used: 2 };
}

export function parseArgs(argv: readonly string[]): EvalArgs {
  const out: EvalArgs = { model: DEFAULT_MODEL, runs: DEFAULT_RUNS, cases: [] };
  // pnpm may pass a "--" separator through to the script.
  const args = argv.filter((arg) => arg !== "--");
  for (let i = 0; i < args.length; ) {
    const { name, value, used } = splitFlag(args[i] as string, args[i + 1]);
    if (value === undefined || value.startsWith("--")) {
      throw new UsageError(`${name} needs a value.\n${USAGE}`);
    }
    if (name === "--model") {
      if (!MODEL_ID.test(value)) throw new UsageError(`Not a model id: ${value}\n${USAGE}`);
      if (RESERVED_IDS.has(value)) {
        throw new UsageError(`"${value}" names an offline recording set, not a model.\n${USAGE}`);
      }
      out.model = value;
    } else if (name === "--runs") {
      const runs = Number(value);
      if (!Number.isInteger(runs) || runs < 1 || runs > MAX_RUNS) {
        throw new UsageError(`--runs must be a whole number from 1 to ${MAX_RUNS}.\n${USAGE}`);
      }
      out.runs = runs;
    } else if (name === "--case") {
      out.cases.push(
        ...value
          .split(",")
          .map((part) => part.trim())
          .filter(Boolean),
      );
    } else {
      throw new UsageError(`Unknown option: ${name}\n${USAGE}`);
    }
    i += used;
  }
  return out;
}
