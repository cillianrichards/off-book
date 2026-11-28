// How a round looks on chessground (P2-15), kept apart from the component so it can be tested. As in lila:
// the board faces the player, they may move only their own pieces, and while it is the opponent's turn a
// move of their own is held as a premove, played the moment the opponent has moved.

import type { Config } from '@lichess-org/chessground/config';
import type { Key } from '@lichess-org/chessground/types';

import type { Position, Round } from './round.ts';

export function boardConfig(round: Round, position: Position): Config {
  return {
    fen: position.fen,
    orientation: round.you,
    turnColor: position.turn,
    check: position.check,
    lastMove: position.lastMove === undefined ? [] : [...position.lastMove],
    movable: {
      free: false,
      // Set even on the opponent's turn: chessground treats a move then as a premove.
      color: position.playing ? round.you : undefined,
      dests: position.dests as Map<Key, Key[]>,
      showDests: true,
    },
    premovable: { enabled: position.playing, showDests: true, castle: true },
    draggable: { enabled: position.playing, showGhost: true },
    selectable: { enabled: position.playing },
  };
}
