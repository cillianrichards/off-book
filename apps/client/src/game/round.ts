// What a player's game page shows, kept from the server's messages (P2-15), in the spirit of lila's round
// controller. The server owns the game: the board is always rebuilt by replaying the server's own move list
// from the starting FEN, never from the client's history (P2-09). The one thing the client adds is its own
// move while it waits for the server to confirm it, so the piece does not jump back in the meantime.
//
// Pure: no sockets, no DOM, no timers. The page feeds it messages and acts on the effects it returns.

import { ChessGame, type Colour, type Promotion, type Square } from '@off-book/rules';
import type { ClientMessage, GameView, OpponentStatus, ServerMessage } from '@off-book/protocol';

export interface Round {
  readonly you: Colour;
  /** The game as the server last described it, with every move it has confirmed. */
  readonly game: GameView;
  readonly opponent: OpponentStatus;
  /** The player's own move, sent but not yet confirmed. */
  readonly pending?: { readonly ply: number; readonly uci: string };
}

/** What the page should do once a message has been applied. */
export type Effect =
  | { readonly type: 'sound'; readonly sound: 'move' | 'capture' }
  /** Ask the server for the whole game again: a message was missed, or a move was refused. */
  | { readonly type: 'send'; readonly message: ClientMessage }
  /** It is now the player's turn, so a premove waiting on the board can be played. */
  | { readonly type: 'playPremove' };

/** The position the board shows: the server's moves, then the player's own unconfirmed one. */
export interface Position {
  readonly fen: string;
  readonly turn: Colour;
  readonly moves: readonly string[];
  readonly lastMove?: readonly [Square, Square];
  readonly check: boolean;
  /** Legal moves for the player, only while it is their turn in a game still being played. */
  readonly dests: ReadonlyMap<Square, readonly Square[]>;
  readonly playing: boolean;
}

export function roundFromState(message: Extract<ServerMessage, { t: 'state' }>): Round {
  return { you: message.you, game: message.game, opponent: message.opponent };
}

export function applyMessage(round: Round, message: ServerMessage): { round: Round; effects: Effect[] } {
  switch (message.t) {
    case 'state':
      return reconnected(round, message);
    case 'move': {
      // Already have it: a repeat after a resync.
      if (message.ply < round.game.ply) return { round, effects: [] };
      // A gap: one or more moves were missed, so rebuild from the whole game (P2-09).
      if (message.ply > round.game.ply) return { round, effects: [resync] };
      const game: GameView = {
        ...round.game,
        moves: [...round.game.moves, message.san],
        ply: message.ply + 1,
        fen: message.fen,
        turn: round.game.turn === 'white' ? 'black' : 'white',
        clock: { ...round.game.clock, ...message.clock },
      };
      const ownConfirmed = round.pending?.ply === message.ply && round.pending.uci === message.uci;
      const next: Round = { you: round.you, game, opponent: round.opponent };
      const effects: Effect[] = [];
      // The player heard their own move when they made it.
      if (!ownConfirmed)
        effects.push({ type: 'sound', sound: message.san.includes('x') ? 'capture' : 'move' });
      if (game.turn === round.you && game.status === 'started') effects.push({ type: 'playPremove' });
      return { round: next, effects };
    }
    case 'end': {
      const game: GameView = {
        ...round.game,
        status: message.status,
        termination: message.termination,
        clock: { ...round.game.clock, ...message.clock },
        ...(message.result === undefined ? {} : { result: message.result }),
      };
      return { round: { you: round.you, game, opponent: round.opponent }, effects: [] };
    }
    case 'opponent':
      return {
        round: {
          ...round,
          opponent: {
            connected: message.connected,
            ...(message.claimableAt === undefined ? {} : { claimableAt: message.claimableAt }),
          },
        },
        effects: [],
      };
    case 'ack':
      return { round: withoutPending(round), effects: [] };
    case 'rejected':
      // The server is restarting: keep the move, and resend it once reconnected (P2-08).
      if (message.reason === 'restarting') return { round, effects: [] };
      // A refused move goes back, and the whole game is fetched in case the client had fallen behind.
      if (round.pending !== undefined) return { round: withoutPending(round), effects: [resync] };
      return { round, effects: message.reason === 'stale' ? [resync] : [] };
    case 'pong':
      // The connection's business.
      break;
  }
  return { round, effects: [] };
}

/**
 * The player's move from the board: kept as pending and returned as the message to send, or undefined if
 * it is not theirs to make. The promotion piece is needed only for a pawn reaching the last rank.
 */
export function playMove(
  round: Round,
  from: Square,
  to: Square,
  promotion?: Promotion,
): { round: Round; message: ClientMessage } | undefined {
  if (round.pending !== undefined || round.game.status !== 'started' || round.game.turn !== round.you)
    return undefined;
  const game = ChessGame.replay(round.game.initialFen, round.game.moves);
  const played = game.play({ from, to, ...(promotion === undefined ? {} : { promotion }) });
  if (!played.ok) return undefined;
  const pending = { ply: round.game.ply, uci: played.uci };
  return { round: { ...round, pending }, message: { t: 'move', ply: pending.ply, uci: played.uci } };
}

/** Whether moving from `from` to `to` needs a promotion piece chosen. */
export function needsPromotion(round: Round, from: Square, to: Square): boolean {
  const game = ChessGame.replay(round.game.initialFen, round.game.moves);
  return !game.isLegal({ from, to }) && game.isLegal({ from, to, promotion: 'q' });
}

export function positionOf(round: Round): Position {
  const game = ChessGame.replay(round.game.initialFen, round.game.moves);
  if (round.pending !== undefined) {
    const { uci } = round.pending;
    game.play({
      from: uci.slice(0, 2) as Square,
      to: uci.slice(2, 4) as Square,
      ...(uci.length === 5 ? { promotion: uci[4] as Promotion } : {}),
    });
  }
  const last = game.uciMoves.at(-1);
  const playing = round.game.status === 'started';
  const yours = playing && round.pending === undefined && game.turn === round.you;
  return {
    fen: game.fen,
    turn: game.turn,
    moves: game.moves,
    ...(last === undefined ? {} : { lastMove: [last.slice(0, 2) as Square, last.slice(2, 4) as Square] }),
    check: game.isCheck,
    dests: yours ? game.legalMoves() : new Map(),
    playing,
  };
}

/** Move numbers for the move list, continuing from the starting FEN, as PGN numbers them (P2-18). */
export function numberedMoves(
  initialFen: string,
  moves: readonly string[],
): { readonly number: number; readonly white?: string; readonly black?: string }[] {
  const [, side, , , , fullmove] = initialFen.split(' ');
  let number = Number(fullmove);
  if (!Number.isInteger(number) || number < 1) number = 1;
  const rows: { number: number; white?: string; black?: string }[] = [];
  let index = 0;
  if (side === 'b' && moves.length > 0) {
    rows.push({ number, black: moves[0] });
    number += 1;
    index = 1;
  }
  for (; index < moves.length; index += 2) {
    const white = moves[index] as string;
    const black = moves[index + 1];
    rows.push(black === undefined ? { number, white } : { number, white, black });
    number += 1;
  }
  return rows;
}

const resync: Effect = { type: 'send', message: { t: 'resync' } };

/**
 * The whole game, as sent on every connection. A move still pending from before is resent if the game is
 * where it was when the move was made, and dropped if the server already has it or has moved on.
 */
function reconnected(
  round: Round,
  message: Extract<ServerMessage, { t: 'state' }>,
): { round: Round; effects: Effect[] } {
  const fresh = roundFromState(message);
  const { pending } = round;
  if (pending === undefined || message.game.status !== 'started') return { round: fresh, effects: [] };
  if (message.game.ply === pending.ply && message.game.turn === message.you) {
    return {
      round: { ...fresh, pending },
      effects: [{ type: 'send', message: { t: 'move', ply: pending.ply, uci: pending.uci } }],
    };
  }
  return { round: fresh, effects: [] };
}

function withoutPending(round: Round): Round {
  return { you: round.you, game: round.game, opponent: round.opponent };
}
