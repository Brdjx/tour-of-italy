// The clock a replayed plan sees. It starts at a fixed instant and moves forward only by the
// recorded call times, so planTrip's deadline checks (retry now? time for a repair?) see the time
// the live run saw, and every replay of the same recordings takes the same branches.

export class ReplayClock {
  #elapsedMs = 0;

  constructor(private readonly origin: number) {}

  /** The current replayed time, as Date.now() would give it. */
  readonly now = (): number => this.origin + this.#elapsedMs;

  /** Milliseconds since the plan started. */
  get elapsedMs(): number {
    return this.#elapsedMs;
  }

  /** Moves the clock to `elapsedMs` after the start. Never moves it back. */
  advanceTo(elapsedMs: number): void {
    this.#elapsedMs = Math.max(this.#elapsedMs, elapsedMs);
  }
}
