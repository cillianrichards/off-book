// A game in play, held in memory by the game service (D-01). It does no I/O and sets no timers: the
// service passes the time in and decides when to save.

import { ChessGame, type Colour, type MoveIntent, type Termination } from '@off-book/rules';

import {
  type ClockState,
  centisOfMillis,
  flagDueAt,
  isRunning,
  newClock,
  outOfTime,
  remainingAt,
  start,
  step,
  stop,
} from './clock.ts';

export type GameStatus = 'started' | 'finished' | 'aborted';
export type Result = '1-0' | '0-1' | '1/2-1/2';
/** How a game ended: by the rules (P2-03), on time, by abandonment, or aborted before it began. */
export type GameTermination = Termination | 'flag' | 'abandonment' | 'aborted';

export type Ending =
  | { readonly status: 'finished'; readonly result: Result; readonly termination: GameTermination }
  | { readonly status: 'aborted'; readonly termination: 'aborted' };

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

/** A move a player proposes: the ply it is meant for, so a resend cannot be played twice, and the move. */
export interface ProposedMove {
  readonly ply: number;
  readonly uci: string;
  /** The network lag the client reports, in milliseconds, for lag compensation (P2-07). */
  readonly lagMs?: number;
}

export type MoveOutcome =
  | {
      readonly kind: 'moved';
      readonly ply: number;
      readonly san: string;
      readonly uci: string;
      readonly fen: string;
      readonly clock: ClockReading;
      readonly ending?: Ending;
    }
  /** The mover's time had run out before the move arrived: it is not played, and they lose on time. */
  | { readonly kind: 'flagged'; readonly ending: Ending }
  /** The same move again for a ply already played by this player: a resend, which changes nothing. */
  | { readonly kind: 'duplicate'; readonly ply: number }
  | { readonly kind: 'rejected'; readonly reason: 'gameOver' | 'stale' | 'notYourTurn' | 'illegal' };

export interface ClockReading {
  /** Each side's remaining time in centiseconds, as it stands when read. */
  readonly white: number;
  readonly black: number;
  readonly running: boolean;
}

export interface ClockView extends ClockSettings, ClockReading {}

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
  readonly result?: Result;
  readonly termination?: GameTermination;
  readonly clock: ClockView;
}

// Lichess's limits for a real-time clock: up to 180 minutes, with up to 180 seconds' increment.
const MAX_INITIAL_SECONDS = 180 * 60;
const MAX_INCREMENT_SECONDS = 180;

const UCI = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/;

export type Created =
  | { readonly ok: true; readonly game: LiveGame }
  | { readonly ok: false; readonly error: string };

export class LiveGame {
  readonly id: string;
  readonly players: Readonly<Record<Colour, string>>;
  readonly clock: ClockSettings;
  readonly createdAt: number;
  readonly #chess: ChessGame;
  // Whoever moves first from the starting FEN, which may be Black (P2-04).
  readonly #firstMover: Colour;
  #clock: ClockState;
  // Each side's remaining time after each of its moves, in centiseconds, as lila records it.
  readonly #clockHistory: Record<Colour, number[]> = { white: [], black: [] };
  #ending: Ending | undefined;
  #lastMoveAt: number | undefined;
  #finishedAt: number | undefined;

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
    this.#firstMover = chess.turn;
    this.#clock = newClock(clock, chess.turn);
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
    return this.#ending?.status ?? 'started';
  }

  get ending(): Ending | undefined {
    return this.#ending;
  }

  get ply(): number {
    return this.#chess.moves.length;
  }

  get turn(): Colour {
    return this.#chess.turn;
  }

  get lastMoveAt(): number | undefined {
    return this.#lastMoveAt;
  }

  get finishedAt(): number | undefined {
    return this.#finishedAt;
  }

  get clockHistory(): Readonly<Record<Colour, readonly number[]>> {
    return { white: [...this.#clockHistory.white], black: [...this.#clockHistory.black] };
  }

  clockAt(now: number): ClockReading {
    return {
      white: remainingAt(this.#clock, 'white', now),
      black: remainingAt(this.#clock, 'black', now),
      running: isRunning(this.#clock),
    };
  }

  /** When the server should next check for a flag, or undefined while no clock is running (P2-07). */
  get flagCheckDueAt(): number | undefined {
    return this.#ending === undefined ? flagDueAt(this.#clock) : undefined;
  }

  /** Ends the game if the side to move is out of time, allowing grace for a move on its way. */
  flagIfOutOfTime(now: number): Ending | undefined {
    if (this.#ending !== undefined || !outOfTime(this.#clock, this.turn, now, true)) return undefined;
    return this.#flag(now);
  }

  colourOf(userId: string): Colour | undefined {
    if (userId === this.players.white) return 'white';
    if (userId === this.players.black) return 'black';
    return undefined;
  }

  /** How many moves a side has made since the starting FEN. */
  movesBy(colour: Colour): number {
    const plies = this.ply;
    return colour === this.#firstMover ? Math.ceil(plies / 2) : Math.floor(plies / 2);
  }

  /**
   * Plays a player's move if it is theirs to make, legal, and meant for this ply (P2-06). The ply makes a
   * resend harmless: the same move again for a ply this player has already played is a duplicate, and
   * anything else meant for another ply is stale.
   */
  move(colour: Colour, proposed: ProposedMove, now: number): MoveOutcome {
    if (this.#ending !== undefined) return { kind: 'rejected', reason: 'gameOver' };
    if (proposed.ply !== this.ply) {
      const resent =
        proposed.ply < this.ply &&
        this.#chess.uciMoves[proposed.ply] === proposed.uci &&
        this.#moverOf(proposed.ply) === colour;
      return resent ? { kind: 'duplicate', ply: proposed.ply } : { kind: 'rejected', reason: 'stale' };
    }
    if (colour !== this.turn) return { kind: 'rejected', reason: 'notYourTurn' };
    const intent = parseUci(proposed.uci);
    if (intent === undefined || !this.#chess.isLegal(intent)) return { kind: 'rejected', reason: 'illegal' };

    // Timed on receipt: a move that arrives after its player's time ran out is not played (P2-07).
    const lagCs = proposed.lagMs === undefined ? undefined : centisOfMillis(proposed.lagMs);
    if (step(this.#clock, now, lagCs, true).flagged) return { kind: 'flagged', ending: this.#flag(now) };

    const played = this.#chess.play(intent);
    if (!played.ok) throw new Error(`${proposed.uci} was legal but could not be played`);
    const outcome = this.#chess.outcome;
    this.#clock = step(this.#clock, now, lagCs, outcome === undefined).clock;
    // The clock starts only once each side has moved, as on Lichess.
    if (this.ply === 2 && outcome === undefined) this.#clock = start(this.#clock, now);
    this.#clockHistory[colour].push(this.#clock.remaining[colour]);
    this.#lastMoveAt = now;

    const ply = this.ply - 1;
    const moved = { kind: 'moved', ply, san: played.san, uci: played.uci, fen: this.#chess.fen } as const;
    if (outcome === undefined) return { ...moved, clock: this.clockAt(now) };
    const result: Result =
      outcome.termination !== 'checkmate' ? '1/2-1/2' : outcome.winner === 'white' ? '1-0' : '0-1';
    const ending = this.#end({ status: 'finished', result, termination: outcome.termination }, now);
    return { ...moved, clock: this.clockAt(now), ending };
  }

  /** Aborts the game, which only a player who has not yet made their first move may do. */
  abort(colour: Colour, now: number): Ending | undefined {
    if (this.#ending !== undefined || this.movesBy(colour) > 0) return undefined;
    return this.#end({ status: 'aborted', termination: 'aborted' }, now);
  }

  view(now: number): GameView {
    return {
      id: this.id,
      players: this.players,
      initialFen: this.#chess.startFen,
      fen: this.#chess.fen,
      moves: this.#chess.moves,
      ply: this.ply,
      turn: this.turn,
      status: this.status,
      ...(this.#ending?.status === 'finished' ? { result: this.#ending.result } : {}),
      ...(this.#ending === undefined ? {} : { termination: this.#ending.termination }),
      clock: { ...this.clock, ...this.clockAt(now) },
    };
  }

  #moverOf(ply: number): Colour {
    return ply % 2 === 0 ? this.#firstMover : this.#firstMover === 'white' ? 'black' : 'white';
  }

  // The side to move has run out of time. They lose, unless their opponent could never have mated, as
  // lila's finisher decides: a flag against insufficient material is a draw.
  #flag(now: number): Ending {
    const winner: Colour = this.turn === 'white' ? 'black' : 'white';
    const result: Result = this.#chess.opponentHasInsufficientMaterial
      ? '1/2-1/2'
      : winner === 'white'
        ? '1-0'
        : '0-1';
    const remaining = { ...this.#clock.remaining, [this.turn]: 0 };
    this.#clock = { ...this.#clock, remaining, runningSince: undefined };
    return this.#end({ status: 'finished', result, termination: 'flag' }, now);
  }

  #end(ending: Ending, now: number): Ending {
    this.#clock = stop(this.#clock, now);
    this.#ending = ending;
    this.#finishedAt = now;
    return ending;
  }
}

function parseUci(uci: string): MoveIntent | undefined {
  const match = UCI.exec(uci);
  if (match === null) return undefined;
  const [, from, to, promotion] = match;
  return {
    from: from as MoveIntent['from'],
    to: to as MoveIntent['to'],
    ...(promotion === undefined ? {} : { promotion: promotion as NonNullable<MoveIntent['promotion']> }),
  };
}
