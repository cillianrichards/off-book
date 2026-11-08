// The wall clock and timers, passed in so tests can control time. Clocks use wall-clock milliseconds, as
// lila's do, because a running clock's start time must survive a restart (P2-08).

export interface Timer {
  cancel(): void;
}

export interface Time {
  /** Milliseconds since the Unix epoch. */
  now(): number;
  /** Runs `run` once, after `ms` milliseconds, unless cancelled first. */
  after(ms: number, run: () => void): Timer;
}

export const realTime: Time = {
  now: () => Date.now(),
  after(ms, run) {
    const handle = setTimeout(run, Math.max(0, ms));
    return { cancel: () => clearTimeout(handle) };
  },
};
