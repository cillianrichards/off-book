// Where games are saved: a `game` row each (P2-12). The game service decides when (P2-08).

import type { Colour } from '@off-book/rules';

import type { ClockSettings, GameStatus, GameTermination, Result } from './live-game.ts';

/** A game as saved: everything needed to rebuild it in memory. Instants are epoch milliseconds. */
export interface GameRecord {
  readonly id: string;
  readonly players: Readonly<Record<Colour, string>>;
  readonly initialFen: string;
  readonly clock: ClockSettings;
  readonly status: GameStatus;
  /** The moves in SAN from the starting FEN. */
  readonly moves: readonly string[];
  /** Each side's remaining time in centiseconds after each of its moves. */
  readonly clockHistory: Readonly<Record<Colour, readonly number[]>>;
  /** Each side's remaining time in centiseconds after the last move. */
  readonly remaining: Readonly<Record<Colour, number>>;
  /** When the side to move's clock started running, or null when it is not running. */
  readonly clockRunningSince: number | null;
  readonly result: Result | null;
  readonly termination: GameTermination | null;
  readonly createdAt: number;
  readonly lastMoveAt: number | null;
  readonly finishedAt: number | null;
}

export interface GameStore {
  /** Saves a new game; `duplicateId` if its id is taken, so the caller can pick another. */
  insert(record: GameRecord): Promise<'inserted' | 'duplicateId'>;
  /** Saves a game's latest state over the last one saved. */
  update(record: GameRecord): Promise<void>;
  load(id: string): Promise<GameRecord | undefined>;
  /** Every game still being played, oldest first, to reload after a restart. */
  loadStarted(): Promise<GameRecord[]>;
}
