// Messages on a player's game WebSocket, as JSON text frames. Clients only send intents; the server owns
// the game and tells both players what happened.

// The message types themselves are shared with the client, in @off-book/protocol; this module checks what
// clients send.

import type { ClientMessage } from '@off-book/protocol';

export type { ClientMessage, OpponentStatus, Rejection, ServerMessage } from '@off-book/protocol';

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
    case 'claim': {
      const { outcome } = value as { outcome?: unknown };
      return outcome === 'win' || outcome === 'draw' ? { t: 'claim', outcome } : undefined;
    }
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
