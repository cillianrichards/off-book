// Messages on a player's game WebSocket, as JSON text frames. Clients only send intents; the server owns
// the game and tells both players what happened.

import type { Colour } from '@off-book/rules';

import type { ClockReading, GameStatus, GameTermination, GameView, Result } from './live-game.ts';

export type ClientMessage =
  | { readonly t: 'ping' }
  /**
   * A move meant for `ply`, the number of moves already played, so a resend is harmless (P2-06), with
   * the network lag the client measures, in milliseconds, for lag compensation (P2-07).
   */
  | { readonly t: 'move'; readonly ply: number; readonly uci: string; readonly lag?: number }
  | { readonly t: 'abort' }
  /** Asks for the whole game again, as a client does when the plies it was sent skip one (P2-09). */
  | { readonly t: 'resync' };

export type Rejection =
  | 'badMessage'
  | 'gameOver'
  | 'stale'
  | 'notYourTurn'
  | 'illegal'
  | 'notAllowed'
  /** The server is shutting down cleanly; the client should reconnect and resend (P2-08). */
  | 'restarting';

export type ServerMessage =
  /**
   * The whole game, sent on every connection and on request. The client rebuilds its board from these
   * moves, never from its own history (P2-09).
   */
  | { readonly t: 'state'; readonly you: Colour; readonly game: GameView }
  /** A move played, sent to both players; `ply` counts from 0, so a gap shows a missed message. */
  | {
      readonly t: 'move';
      readonly ply: number;
      readonly san: string;
      readonly uci: string;
      readonly fen: string;
      readonly clock: ClockReading;
    }
  | {
      readonly t: 'end';
      readonly status: Exclude<GameStatus, 'started'>;
      readonly result?: Result;
      readonly termination: GameTermination;
      readonly clock: ClockReading;
    }
  /** A resent move that was already played: nothing changed. */
  | { readonly t: 'ack'; readonly ply: number }
  /** An intent refused; `ply` is the game's current ply, so the client can tell it is behind. */
  | { readonly t: 'rejected'; readonly reason: Rejection; readonly ply?: number }
  | { readonly t: 'pong' };

const UCI = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
// A reported lag beyond a minute is not lag; compensation is capped far below this anyway.
const MAX_LAG_MS = 60_000;
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
    case 'resync':
      return { t: 'resync' };
    case 'move': {
      const { ply, uci, lag } = value as { ply?: unknown; uci?: unknown; lag?: unknown };
      if (!Number.isInteger(ply) || (ply as number) < 0 || (ply as number) > MAX_PLY) return undefined;
      if (typeof uci !== 'string' || !UCI.test(uci)) return undefined;
      if (lag === undefined) return { t: 'move', ply: ply as number, uci };
      if (typeof lag !== 'number' || !Number.isFinite(lag) || lag < 0 || lag > MAX_LAG_MS) return undefined;
      return { t: 'move', ply: ply as number, uci, lag };
    }
    default:
      return undefined;
  }
}
