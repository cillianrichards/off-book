// Shared chess rules, wrapping chess.js, used identically by client and server (P2-03).

export { ChessGame } from './game.ts';
export type {
  Colour,
  MoveIntent,
  MoveResult,
  NewGame,
  Outcome,
  Promotion,
  Square,
  Termination,
} from './game.ts';
export { readStartFen, STANDARD_FEN } from './start-fen.ts';
export type { StartFen } from './start-fen.ts';
