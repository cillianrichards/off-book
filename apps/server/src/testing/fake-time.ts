// A clock for tests: time stands still until `advance` moves it, running every timer that falls due, in
// order, including timers those timers set.

import type { Time, Timer } from '../time.ts';

interface Scheduled {
  readonly at: number;
  readonly order: number;
  readonly run: () => void;
  cancelled: boolean;
}

export class FakeTime implements Time {
  #now: number;
  #order = 0;
  readonly #scheduled: Scheduled[] = [];

  constructor(start = Date.UTC(2026, 10, 8, 12)) {
    this.#now = start;
  }

  now(): number {
    return this.#now;
  }

  after(ms: number, run: () => void): Timer {
    const scheduled: Scheduled = {
      at: this.#now + Math.max(0, ms),
      order: this.#order++,
      run,
      cancelled: false,
    };
    this.#scheduled.push(scheduled);
    return {
      cancel: () => {
        scheduled.cancelled = true;
      },
    };
  }

  /** Moves time forward by `ms`, running each timer due on the way at its own time. */
  advance(ms: number): void {
    const end = this.#now + ms;
    for (;;) {
      const next = this.#scheduled
        .filter(scheduled => !scheduled.cancelled && scheduled.at <= end)
        .toSorted((a, b) => a.at - b.at || a.order - b.order)[0];
      if (next === undefined) break;
      next.cancelled = true;
      this.#now = next.at;
      next.run();
    }
    this.#now = end;
  }

  /** How many timers are waiting to run. */
  get pending(): number {
    return this.#scheduled.filter(scheduled => !scheduled.cancelled).length;
  }
}
