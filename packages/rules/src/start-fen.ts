// Starting positions (P2-03). Every game starts from a FEN, so a FEN is checked and cleaned before
// play. The checks follow Lichess's for games from a position: lila's friend challenges
// (`FriendConfig`, `strictFen = false`) accept a position scalachess's FEN reader can read, with one
// king a side, no pawn on the first or last rank, the side not to move not in check, and the game not
// already over.

import { Chess, validateFen } from 'chess.js';

export type StartFen =
  | { readonly ok: true; readonly fen: string }
  | { readonly ok: false; readonly error: string };

export const STANDARD_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

// Lichess caps the half-move clock at 100 rather than refusing a larger one.
const MAX_HALF_MOVES = 100;

const HOME = {
  w: { king: 'e1', k: 'h1', q: 'a1' },
  b: { king: 'e8', k: 'h8', q: 'a8' },
} as const;

/**
 * Checks a FEN as a starting position and returns it cleaned: always six fields, castling rights
 * only where the king and rook are on their home squares, and an en passant square only when a
 * capture there is legal. A position from a real game comes back unchanged apart from its counters.
 */
export function readStartFen(input: string): StartFen {
  const fields = input.trim().split(/\s+/);
  if (fields.length < 4 || fields.length > 6) return refuse('A FEN needs four to six fields.');
  // Lichess reads a FEN without move counters as starting a fresh count, at move 1.
  const halfMoves = fields[4] ?? '0';
  const fullMove = fields[5] ?? '1';
  if (!/^\d+$/.test(halfMoves) || !/^\d+$/.test(fullMove)) {
    return refuse('The move counters must be whole numbers.');
  }
  const counters = [
    String(Math.min(Number(halfMoves), MAX_HALF_MOVES)),
    String(Math.max(Number(fullMove), 1)),
  ];
  const sixFields = [...fields.slice(0, 4), ...counters].join(' ');

  const checked = validateFen(sixFields);
  if (!checked.ok) return refuse(checked.error ?? 'The FEN is not valid.');

  const position = new Chess(sixFields);
  dropUnusableCastlingRights(position);
  // chess.js writes an en passant square only when a capture there is legal, which is how Off Book
  // defines a position everywhere (P1-02). It still keeps an unusable square from the FEN it was
  // given, which would make the position count as different from itself for repetition, so a game
  // must start from this cleaned FEN, never from the input.
  const fen = position.fen();

  if (sideNotToMoveIsInCheck(position)) return refuse('The side not to move is in check.');
  if (
    position.isCheckmate() ||
    position.isStalemate() ||
    position.isInsufficientMaterial() ||
    position.isDrawByFiftyMoves()
  ) {
    return refuse('The game is already over in this position.');
  }
  return { ok: true, fen };
}

// chess.js keeps a castling right the pieces cannot use and then generates the castling move anyway,
// with no rook in the corner or from a king off its home square. scalachess drops such rights when it
// reads a FEN. Off Book plays standard chess, so a right survives only with the king on e1 or e8 and
// the rook in its corner.
function dropUnusableCastlingRights(chess: Chess): void {
  for (const colour of ['w', 'b'] as const) {
    const home = HOME[colour];
    const king = chess.get(home.king);
    const kingAtHome = king?.type === 'k' && king.color === colour;
    for (const side of ['k', 'q'] as const) {
      const rook = chess.get(home[side]);
      const rookAtHome = rook?.type === 'r' && rook.color === colour;
      if (!kingAtHome || !rookAtHome)
        chess.setCastlingRights(colour, side === 'k' ? { k: false } : { q: false });
    }
  }
}

function sideNotToMoveIsInCheck(chess: Chess): boolean {
  const toMove = chess.turn();
  const other = toMove === 'w' ? 'b' : 'w';
  const [king] = chess.findPiece({ type: 'k', color: other });
  return king !== undefined && chess.isAttacked(king, toMove);
}

function refuse(error: string): StartFen {
  return { ok: false, error };
}
