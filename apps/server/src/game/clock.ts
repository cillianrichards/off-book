// The game clock (P2-07), following scalachess's Clock and LagTracker, which run Lichess's clocks.
//
// - Time is taken on the server's receipt of a move, never from the client.
// - Lag compensation: the time a client reports losing to the network is given back, but only up to a
//   quota per player. The quota starts at three moves' worth of gain, grows by the gain each move, less
//   what was given back, and never exceeds seven moves' worth. The gain is a second per move for
//   anything of three minutes or more (10+0 included). lila also lowers the gain to the frame lag its
//   WebSocket server measures; Off Book measures none, so the gain stays at lila's maximum.
// - The clock starts after each side has moved once, so neither player's time runs before then.
// - A move that arrives after its player's time ran out, even with compensation, is not played: the
//   player has lost on time.
// - A flag found by the server's own check allows the player's quota, at most two seconds, as grace,
//   since a move may be on its way.
//
// All durations are centiseconds; instants are epoch milliseconds, so a running clock survives a restart.

import type { Colour } from '@off-book/rules';

import type { ClockSettings } from './live-game.ts';

export interface ClockState {
  readonly incrementCs: number;
  /** Each side's remaining time as of the last move, before the running side's current think. */
  readonly remaining: Readonly<Record<Colour, number>>;
  /** Whose clock it is: the side to move. */
  readonly turn: Colour;
  /** When the side to move's clock started running; undefined before the clock starts and once it stops. */
  readonly runningSince: number | undefined;
  readonly quota: Readonly<Record<Colour, number>>;
  readonly quotaGain: number;
}

export interface Step {
  readonly clock: ClockState;
  /** The mover had run out of time before the move arrived, even after compensation. */
  readonly flagged: boolean;
}

const MAX_GRACE_CS = 200;

const other = (colour: Colour): Colour => (colour === 'white' ? 'black' : 'white');

/** Milliseconds to centiseconds, rounded half away from zero, as scalachess's `Centis.ofMillis`. */
export const centisOfMillis = (ms: number): number => Math.trunc((ms > 0 ? ms + 5 : ms - 4) / 10) || 0;

/** The lag quota's gain per move: scalachess's maximum, a second for three minutes or more. */
export const quotaGainFor = ({ initialSeconds, incrementSeconds }: ClockSettings): number => {
  const estimatedTotalSeconds = initialSeconds + 40 * incrementSeconds;
  return Math.min(100, Math.trunc((estimatedTotalSeconds * 2) / 5) + 15);
};

export function newClock(settings: ClockSettings, turn: Colour): ClockState {
  const quotaGain = quotaGainFor(settings);
  const initial = settings.initialSeconds * 100;
  return {
    incrementCs: settings.incrementSeconds * 100,
    remaining: { white: initial, black: initial },
    turn,
    runningSince: undefined,
    quota: { white: quotaGain * 3, black: quotaGain * 3 },
    quotaGain,
  };
}

export const isRunning = (clock: ClockState): boolean => clock.runningSince !== undefined;

/** Starts the side to move's clock, if it is not already running. */
export const start = (clock: ClockState, now: number): ClockState =>
  isRunning(clock) ? clock : { ...clock, runningSince: now };

const elapsed = (clock: ClockState, now: number): number =>
  clock.runningSince === undefined ? 0 : centisOfMillis(now - clock.runningSince);

/** A side's remaining time at `now`, never below zero. */
export function remainingAt(clock: ClockState, colour: Colour, now: number): number {
  const running = colour === clock.turn ? elapsed(clock, now) : 0;
  return Math.max(0, clock.remaining[colour] - running);
}

/** Whether a side is out of time at `now`; with grace, as the server's own check allows. */
export function outOfTime(clock: ClockState, colour: Colour, now: number, withGrace: boolean): boolean {
  if (colour !== clock.turn || clock.runningSince === undefined) return clock.remaining[colour] <= 0;
  const grace = withGrace ? Math.min(clock.quota[colour], MAX_GRACE_CS) : 0;
  return clock.remaining[colour] <= Math.max(0, elapsed(clock, now) - grace);
}

/** When the side to move will be out of time with grace, or undefined while the clock is not running. */
export function flagDueAt(clock: ClockState): number | undefined {
  if (clock.runningSince === undefined) return undefined;
  const grace = Math.min(clock.quota[clock.turn], MAX_GRACE_CS);
  return clock.runningSince + (clock.remaining[clock.turn] + grace) * 10;
}

/**
 * The side to move has moved: charge them the time since their clock started, less lag compensation,
 * add the increment and pass the clock over. `gameActive` is false when the move ended the game, which
 * then gets no increment and stops the clock.
 */
export function step(
  clock: ClockState,
  now: number,
  reportedLagCs: number | undefined,
  gameActive: boolean,
): Step {
  const mover = clock.turn;
  if (clock.runningSince === undefined) return { clock: { ...clock, turn: other(mover) }, flagged: false };

  const lag = Math.max(0, reportedLagCs ?? 0);
  const compensation = Math.min(lag, clock.quota[mover]);
  const quota = Math.min(clock.quota[mover] + clock.quotaGain - compensation, clock.quotaGain * 7);
  const moveTime = Math.max(0, elapsed(clock, now) - compensation);
  const stillRunning = gameActive && moveTime < clock.remaining[mover];
  const increment = stillRunning ? clock.incrementCs : 0;
  const remaining = clock.remaining[mover] - moveTime + increment;
  return {
    clock: {
      ...clock,
      remaining: { ...clock.remaining, [mover]: remaining },
      quota: { ...clock.quota, [mover]: quota },
      turn: other(mover),
      runningSince: stillRunning ? now : undefined,
    },
    flagged: remaining <= 0,
  };
}

/** Stops the clock at `now`, charging the side to move for their time so far. */
export function stop(clock: ClockState, now: number): ClockState {
  if (clock.runningSince === undefined) return clock;
  const remaining = clock.remaining[clock.turn] - elapsed(clock, now);
  return { ...clock, remaining: { ...clock.remaining, [clock.turn]: remaining }, runningSince: undefined };
}

/** Adds time to a side's clock, as lila does on a clean shutdown (P2-08). */
export const giveTime = (clock: ClockState, colour: Colour, cs: number): ClockState => ({
  ...clock,
  remaining: { ...clock.remaining, [colour]: clock.remaining[colour] + cs },
});
