// Mating material, as scalachess's InsufficientMatingMaterial decides it, so that a flag or an abandoned
// game is a draw rather than a win when the winner could never have mated (P2-07, P2-10). It reads only
// the FEN's piece placement, as scalachess reads only the board.

type Side = 'w' | 'b';
type PieceType = 'p' | 'n' | 'b' | 'r' | 'q' | 'k';

export interface PlacedPiece {
  readonly type: PieceType;
  readonly side: Side;
  /** True on a dark square (a1 is dark). */
  readonly dark: boolean;
}

/** Every piece in a FEN's placement field. */
export function piecesOf(fen: string): PlacedPiece[] {
  const placement = fen.split(' ')[0] ?? '';
  const pieces: PlacedPiece[] = [];
  for (const [index, row] of placement.split('/').entries()) {
    const rank = 7 - index;
    let file = 0;
    for (const char of row) {
      if (/\d/.test(char)) {
        file += Number(char);
        continue;
      }
      const type = char.toLowerCase() as PieceType;
      pieces.push({ type, side: char === type ? 'b' : 'w', dark: (file + rank) % 2 === 0 });
      file += 1;
    }
  }
  return pieces;
}

/** Whether there are bishops on both colours of square, whichever sides they belong to. */
export function bishopsOnOppositeColours(pieces: readonly PlacedPiece[]): boolean {
  const bishops = pieces.filter(piece => piece.type === 'b');
  return bishops.some(piece => piece.dark) && bishops.some(piece => !piece.dark);
}

/**
 * Whether `side` cannot mate, by scalachess's rule: it has only its king; or king and one knight against
 * a king with nothing but queens; or king and bishops, when there are no bishops on opposite colours
 * and the other side has no knight or pawn.
 */
export function hasInsufficientMatingMaterial(pieces: readonly PlacedPiece[], side: Side): boolean {
  const own = pieces.filter(piece => piece.side === side && piece.type !== 'k');
  const theirs = pieces.filter(piece => piece.side !== side && piece.type !== 'k');
  const onlyKing = own.length === 0;
  const kingAndKnight = own.length === 1 && own[0]?.type === 'n' && theirs.every(piece => piece.type === 'q');
  const kingAndBishops =
    own.every(piece => piece.type === 'b') &&
    !bishopsOnOppositeColours(pieces) &&
    !theirs.some(piece => piece.type === 'n' || piece.type === 'p');
  return onlyKing || kingAndKnight || kingAndBishops;
}

const VALUES: Readonly<Record<PieceType, number>> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

/** White's material minus Black's, in pawns (pawn 1, knight and bishop 3, rook 5, queen 9). */
export function materialImbalance(pieces: readonly PlacedPiece[]): number {
  return pieces.reduce((sum, piece) => sum + VALUES[piece.type] * (piece.side === 'w' ? 1 : -1), 0);
}
