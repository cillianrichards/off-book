// What the game module announces on the bus (P2-11), each once the change it describes is saved. Rating
// (Phase 4) and fair play (Phase 5) will listen; nothing does yet.

import type { Colour } from '@off-book/rules';

import type { Bus } from '../bus.ts';
import type { ClockSettings, GameTermination, Result } from './live-game.ts';

export type GameEvent =
  | {
      readonly type: 'game.started';
      readonly gameId: string;
      readonly players: Readonly<Record<Colour, string>>;
      readonly initialFen: string;
      readonly clock: ClockSettings;
      readonly at: number;
    }
  | {
      readonly type: 'game.finished';
      readonly gameId: string;
      readonly players: Readonly<Record<Colour, string>>;
      readonly result: Result;
      readonly termination: GameTermination;
      readonly moveCount: number;
      /** Each side's time left at the end, and after each of its moves, in centiseconds. */
      readonly clock: {
        readonly remaining: Readonly<Record<Colour, number>>;
        readonly history: Readonly<Record<Colour, readonly number[]>>;
      };
      /** The pool position the game started from; null until games come from the pool (P3-13). */
      readonly positionId: null;
      readonly at: number;
    }
  | { readonly type: 'game.aborted'; readonly gameId: string; readonly at: number };

export type GameBus = Bus<GameEvent>;
