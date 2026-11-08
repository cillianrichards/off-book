// A game in play, held in memory by the game service (D-01). It does no I/O and sets no timers: the
// service passes the time in and decides when to save.

import { ChessGame, type Colour } from '@off-book/rules';

export type GameStatus = 'started' | 'finished' | 'aborted';

export interface ClockSettings {
  readonly initialSeconds: number;
  readonly incrementSeconds: number;
}

export interface NewGame {
  readonly id: string;
  readonly white: string;
  readonly black: string;
  readonly initialFen: string;
  readonly clock: ClockSettings;
  readonly now: number;
}

export interface ClockView extends ClockSettings {
  /** Each side's remaining time in centiseconds, as it stands when the view is taken. */
  readonly white: number;
  readonly black: number;
  readonly running: boolean;
}

export interface GameView {
  readonly id: string;
  readonly players: Readonly<Record<Colour, string>>;
  readonly initialFen: string;
  readonly fen: string;
  /** Every move since the starting FEN, in SAN; the client rebuilds the game from these (P2-09). */
  readonly moves: readonly string[];
  readonly ply: number;
  readonly turn: Colour;
  readonly status: GameStatus;
  readonly clock: ClockView;
}

// Lichess's limits for a real-time clock: up to 180 minutes, with up to 180 seconds' increment.
const MAX_INITIAL_SECONDS = 180 * 60;
const MAX_INCREMENT_SECONDS = 180;

export type Created =
  | { readonly ok: true; readonly game: LiveGame }
  | { readonly ok: false; readonly error: string };

export class LiveGame {
  readonly id: string;
  readonly players: Readonly<Record<Colour, string>>;
  readonly clock: ClockSettings;
  readonly createdAt: number;
  readonly #chess: ChessGame;
  #status: GameStatus = 'started';

  private constructor(
    id: string,
    players: Record<Colour, string>,
    chess: ChessGame,
    clock: ClockSettings,
    createdAt: number,
  ) {
    this.id = id;
    this.players = players;
    this.#chess = chess;
    this.clock = clock;
    this.createdAt = createdAt;
  }

  static create(input: NewGame): Created {
    if (input.white === input.black) return { ok: false, error: 'A player cannot play both sides.' };
    const { initialSeconds, incrementSeconds } = input.clock;
    if (!Number.isInteger(initialSeconds) || initialSeconds < 1 || initialSeconds > MAX_INITIAL_SECONDS) {
      return { ok: false, error: `The clock must start with 1 to ${MAX_INITIAL_SECONDS} seconds.` };
    }
    if (
      !Number.isInteger(incrementSeconds) ||
      incrementSeconds < 0 ||
      incrementSeconds > MAX_INCREMENT_SECONDS
    ) {
      return { ok: false, error: `The increment must be 0 to ${MAX_INCREMENT_SECONDS} seconds.` };
    }
    const chess = ChessGame.fromFen(input.initialFen);
    if (!chess.ok) return chess;
    const players = { white: input.white, black: input.black };
    return { ok: true, game: new LiveGame(input.id, players, chess.game, input.clock, input.now) };
  }

  get status(): GameStatus {
    return this.#status;
  }

  get ply(): number {
    return this.#chess.moves.length;
  }

  colourOf(userId: string): Colour | undefined {
    if (userId === this.players.white) return 'white';
    if (userId === this.players.black) return 'black';
    return undefined;
  }

  view(_now: number): GameView {
    const initialCs = this.clock.initialSeconds * 100;
    return {
      id: this.id,
      players: this.players,
      initialFen: this.#chess.startFen,
      fen: this.#chess.fen,
      moves: this.#chess.moves,
      ply: this.ply,
      turn: this.#chess.turn,
      status: this.#status,
      clock: { ...this.clock, white: initialCs, black: initialCs, running: false },
    };
  }
}
