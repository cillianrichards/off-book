// Messages on a player's game WebSocket, as JSON text frames. Clients only send intents; the server owns
// the game and tells both players what happened.

import type { Colour } from '@off-book/rules';

import type { GameView } from './live-game.ts';

export type ClientMessage = { readonly t: 'ping' };

export type Rejection = 'badMessage';

export type ServerMessage =
  | { readonly t: 'state'; readonly you: Colour; readonly game: GameView }
  | { readonly t: 'pong' }
  | { readonly t: 'rejected'; readonly reason: Rejection };

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
    default:
      return undefined;
  }
}
