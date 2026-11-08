// A game of chess from any starting FEN (P2-03), shared by client and server.
//
// Which endings are automatic follows scalachess, Lichess's rules library: checkmate, stalemate,
// insufficient material, the fifty-move rule at 100 half-moves and fivefold repetition end the game
// by themselves, in that order of precedence, so checkmate on the hundredth half-move is still
// checkmate. Threefold repetition only lets a player claim a draw, and only for the position on the
// board, as on Lichess.

import { Chess, type Move, type Square } from 'chess.js';

import { readStartFen } from './start-fen.ts';

export type { Square };
export type Colour = 'white' | 'black';
export type Promotion = 'q' | 'r' | 'b' | 'n';

export interface MoveIntent {
  readonly from: Square;
  readonly to: Square;
  readonly promotion?: Promotion;
}

export type Termination =
  | 'checkmate'
  | 'stalemate'
  | 'insufficientMaterial'
  | 'fiftyMoves'
  | 'fivefoldRepetition';

export type Outcome =
  | { readonly termination: 'checkmate'; readonly winner: Colour }
  | { readonly termination: Exclude<Termination, 'checkmate'> };

export type MoveResult =
  | { readonly ok: true; readonly san: string; readonly uci: string }
  | { readonly ok: false; readonly error: 'illegal' | 'gameOver' };

export type NewGame =
  | { readonly ok: true; readonly game: ChessGame }
  | { readonly ok: false; readonly error: string };

export class ChessGame {
  readonly startFen: string;
  readonly #chess: Chess;
  readonly #moves: string[] = [];
  readonly #uciMoves: string[] = [];
  // How many times each position has occurred since the starting FEN, which counts as the first.
  readonly #occurrences = new Map<string, number>();
  #outcome: Outcome | undefined;

  private constructor(startFen: string) {
    this.startFen = startFen;
    this.#chess = new Chess(startFen);
    this.#countPosition();
    this.#outcome = undefined;
  }

  /** Starts a game from any FEN a player supplies, checked and cleaned by `readStartFen`. */
  static fromFen(input: string): NewGame {
    const start = readStartFen(input);
    return start.ok ? { ok: true, game: new ChessGame(start.fen) } : start;
  }

  /**
   * Rebuilds a game from its stored starting FEN and moves in SAN, as the server does after a restart.
   * Stored games were valid when saved, so anything that will not replay is corrupt and throws.
   */
  static replay(startFen: string, sans: readonly string[]): ChessGame {
    const start = readStartFen(startFen);
    if (!start.ok) throw new Error(`Stored starting FEN is not valid: ${start.error}`);
    const game = new ChessGame(start.fen);
    for (const [index, san] of sans.entries()) {
      if (game.#outcome !== undefined)
        throw new Error(`Stored move ${index + 1} (${san}) follows the end of the game.`);
      let played: Move;
      try {
        played = game.#chess.move(san, { strict: true });
      } catch {
        throw new Error(`Stored move ${index + 1} (${san}) is not legal.`);
      }
      game.#afterMove(played);
    }
    return game;
  }

  get fen(): string {
    return this.#chess.fen();
  }

  get turn(): Colour {
    return this.#chess.turn() === 'w' ? 'white' : 'black';
  }

  /** The moves played since the starting FEN, in SAN. */
  get moves(): readonly string[] {
    return [...this.#moves];
  }

  /** The same moves in UCI, such as `e2e4`, `e1g1` or `e7e8q`. */
  get uciMoves(): readonly string[] {
    return [...this.#uciMoves];
  }

  get isCheck(): boolean {
    return this.#chess.isCheck();
  }

  /** How the game ended by itself, or undefined while it can go on. */
  get outcome(): Outcome | undefined {
    return this.#outcome;
  }

  /** Whether the player to move may claim a draw by threefold repetition. */
  get canClaimThreefold(): boolean {
    return this.#outcome === undefined && this.#timesCurrentPositionOccurred() >= 3;
  }

  /** Every legal move, as a map from each origin square to its destinations; empty once the game is over. */
  legalMoves(): Map<Square, Square[]> {
    const destinations = new Map<Square, Square[]>();
    if (this.#outcome !== undefined) return destinations;
    for (const move of this.#chess.moves({ verbose: true })) {
      const targets = destinations.get(move.from) ?? [];
      // A promotion is one destination, whichever piece is chosen.
      if (!targets.includes(move.to)) targets.push(move.to);
      destinations.set(move.from, targets);
    }
    return destinations;
  }

  /** Plays a move if it is exactly a legal one, including the promotion piece when and only when one is needed. */
  play(intent: MoveIntent): MoveResult {
    if (this.#outcome !== undefined) return { ok: false, error: 'gameOver' };
    const legal = this.#findLegal(intent);
    if (legal === undefined) return { ok: false, error: 'illegal' };
    const played = this.#chess.move(legal.san, { strict: true });
    this.#afterMove(played);
    return { ok: true, san: played.san, uci: played.lan };
  }

  /** Whether `play` would accept the move, without playing it. */
  isLegal(intent: MoveIntent): boolean {
    return this.#outcome === undefined && this.#findLegal(intent) !== undefined;
  }

  // chess.js would ignore a promotion piece on a move that does not promote, and Lichess treats such a
  // move as illegal, so the intent must match a legal move exactly.
  #findLegal(intent: MoveIntent): Move | undefined {
    return this.#chess
      .moves({ verbose: true, square: intent.from })
      .find(move => move.to === intent.to && move.promotion === intent.promotion);
  }

  #afterMove(move: Move): void {
    this.#moves.push(move.san);
    this.#uciMoves.push(move.lan);
    this.#countPosition();
    this.#outcome = this.#endedBy();
  }

  #endedBy(): Outcome | undefined {
    const chess = this.#chess;
    if (chess.isCheckmate())
      return { termination: 'checkmate', winner: chess.turn() === 'w' ? 'black' : 'white' };
    if (chess.isStalemate()) return { termination: 'stalemate' };
    if (chess.isInsufficientMaterial()) return { termination: 'insufficientMaterial' };
    if (chess.isDrawByFiftyMoves()) return { termination: 'fiftyMoves' };
    if (this.#timesCurrentPositionOccurred() >= 5) return { termination: 'fivefoldRepetition' };
    return undefined;
  }

  #countPosition(): void {
    const key = positionKey(this.#chess.fen());
    this.#occurrences.set(key, (this.#occurrences.get(key) ?? 0) + 1);
  }

  #timesCurrentPositionOccurred(): number {
    return this.#occurrences.get(positionKey(this.#chess.fen())) ?? 0;
  }
}

// A position for repetition is its placement, side to move, castling rights and en passant square,
// the first four fields of chess.js's FEN, which carries an en passant square only when a capture is
// legal. That is FIDE's definition, and P1-02's.
function positionKey(fen: string): string {
  return fen.split(' ').slice(0, 4).join(' ');
}
