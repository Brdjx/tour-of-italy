import { LlmError } from "../llm/errors";

// Runs one model call with a hard time limit. The call gets an AbortSignal that fires at the
// limit, and the returned promise settles by then even if the call ignores the signal, so no
// client (real, fixture, or buggy) can hold a request past its budget.

export async function callWithin<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new LlmError("timeout", `Model call exceeded ${timeoutMs} ms`));
    }, timeoutMs);
  });
  try {
    // Promise.resolve().then(...) turns a synchronous throw inside `run` into a rejection.
    return await Promise.race([Promise.resolve().then(() => run(controller.signal)), expired]);
  } finally {
    clearTimeout(timer);
  }
}
