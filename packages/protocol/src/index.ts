// The game WebSocket's messages and the views they carry, shared by server and client (P2-14 to P2-17), so
// neither can drift from the other. Types only: the server's checks on what clients send stay in the server.

import type { Colour, Termination } from '@off-book/rules';

export type GameStatus = 'started' | 'finished' | 'aborted';
export type Result = '1-0' | '0-1' | '1/2-1/2';
/** How a game ended: by the rules (P2-03), on time, by abandonment, or aborted before it began. */
export type GameTermination = Termination | 'flag' | 'abandonment' | 'aborted';

export interface ClockSettings {
  readonly initialSeconds: number;
  readonly incrementSeconds: number;
}

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

export type ClientMessage =
  | { readonly t: 'ping' }
  /**
   * A move meant for `ply`, the number of moves already played, so a resend is harmless (P2-06), with
   * the network lag the client measures, in milliseconds, for lag compensation (P2-07).
   */
  | { readonly t: 'move'; readonly ply: number; readonly uci: string; readonly lag?: number }
  | { readonly t: 'abort' }
  /** Asks for the whole game again, as a client does when the plies it was sent skip one (P2-09). */
  | { readonly t: 'resync' }
  /** Claims the game from an opponent who has left it (P2-10). */
  | { readonly t: 'claim'; readonly outcome: 'win' | 'draw' };

export type Rejection =
  | 'badMessage'
  | 'gameOver'
  | 'stale'
  | 'notYourTurn'
  | 'illegal'
  | 'notAllowed'
  /** The server is shutting down cleanly; the client should reconnect and resend (P2-08). */
  | 'restarting'
  /** The opponent has not been gone long enough, or it is the claimer's own turn (P2-10). */
  | 'notClaimable';

/** Whether a player's opponent is connected, and if not, from when the game can be claimed (P2-10). */
export interface OpponentStatus {
  readonly connected: boolean;
  /** Epoch milliseconds; present while the opponent is disconnected from a game in play. */
  readonly claimableAt?: number;
}

export type ServerMessage =
  /**
   * The whole game, sent on every connection and on request. The client rebuilds its board from these
   * moves, never from its own history (P2-09).
   */
  | { readonly t: 'state'; readonly you: Colour; readonly game: GameView; readonly opponent: OpponentStatus }
  /** The opponent has disconnected or come back. */
  | ({ readonly t: 'opponent' } & OpponentStatus)
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
