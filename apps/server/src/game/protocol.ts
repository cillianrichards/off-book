// Messages on a player's game WebSocket, as JSON text frames. Clients only send intents; the server owns
// the game and tells both players what happened.

import type { Colour } from '@off-book/rules';

import type { GameStatus, GameTermination, GameView, Result } from './live-game.ts';

export type ClientMessage =
  | { readonly t: 'ping' }
  /** A move meant for `ply`, the number of moves already played, so a resend is harmless (P2-06). */
  | { readonly t: 'move'; readonly ply: number; readonly uci: string }
  | { readonly t: 'abort' };

export type Rejection = 'badMessage' | 'gameOver' | 'stale' | 'notYourTurn' | 'illegal' | 'notAllowed';

export type ServerMessage =
  | { readonly t: 'state'; readonly you: Colour; readonly game: GameView }
  /** A move played, sent to both players; `ply` counts from 0, so a gap shows a missed message. */
  | {
      readonly t: 'move';
      readonly ply: number;
      readonly san: string;
      readonly uci: string;
      readonly fen: string;
    }
  | {
      readonly t: 'end';
      readonly status: Exclude<GameStatus, 'started'>;
      readonly result?: Result;
      readonly termination: GameTermination;
    }
  /** A resent move that was already played: nothing changed. */
  | { readonly t: 'ack'; readonly ply: number }
  /** An intent refused; `ply` is the game's current ply, so the client can tell it is behind. */
  | { readonly t: 'rejected'; readonly reason: Rejection; readonly ply?: number }
  | { readonly t: 'pong' };

const UCI = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
// Lichess's limit on the length of a game; a ply beyond it cannot be a real one.
const MAX_PLY = 600;

/** Reads a client message, or returns undefined for anything that is not one. */
export function parseClientMessage(text: string): ClientMessage | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || !('t' in value)) return undefined;
  switch (value.t) {
    case 'ping':
      return { t: 'ping' };
    case 'abort':
      return { t: 'abort' };
    case 'move': {
      const { ply, uci } = value as { ply?: unknown; uci?: unknown };
      if (!Number.isInteger(ply) || (ply as number) < 0 || (ply as number) > MAX_PLY) return undefined;
      if (typeof uci !== 'string' || !UCI.test(uci)) return undefined;
      return { t: 'move', ply: ply as number, uci };
    }
    default:
      return undefined;
  }
}
