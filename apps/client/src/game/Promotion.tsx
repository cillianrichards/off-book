// The promotion picker (P2-15), laid over the board as lila's is: the four pieces stacked down the file of
// the promotion square, queen nearest the board's edge. Choosing outside it cancels the move. Pieces are
// chessground's own <piece> elements, so they share the board's piece set.

import { createElement } from 'react';

import type { Colour, Promotion as Piece, Square } from '@off-book/rules';

const PIECES: readonly { readonly piece: Piece; readonly role: string }[] = [
  { piece: 'q', role: 'queen' },
  { piece: 'n', role: 'knight' },
  { piece: 'r', role: 'rook' },
  { piece: 'b', role: 'bishop' },
];

export interface PromotionProps {
  readonly square: Square;
  readonly colour: Colour;
  /** Which way the board faces, so the column sits under the right file. */
  readonly orientation: Colour;
  readonly onChoose: (piece: Piece) => void;
  readonly onCancel: () => void;
}

export function Promotion({ square, colour, orientation, onChoose, onCancel }: PromotionProps) {
  const file = square.charCodeAt(0) - 'a'.charCodeAt(0);
  const column = orientation === 'white' ? file : 7 - file;
  // The promotion square is on the edge the player faces away from, so the column runs down from the top.
  const fromTop = (colour === 'white') === (orientation === 'white');
  return (
    <div className="promotion" role="dialog" aria-label="Promote to" onClick={onCancel}>
      {PIECES.map(({ piece, role }, index) => (
        <button
          key={piece}
          type="button"
          className="promotion-choice"
          aria-label={role}
          style={{
            left: `${column * 12.5}%`,
            ...(fromTop ? { top: `${index * 12.5}%` } : { bottom: `${index * 12.5}%` }),
          }}
          onClick={event => {
            event.stopPropagation();
            onChoose(piece);
          }}>
          {createElement('piece', { className: `${role} ${colour}` })}
        </button>
      ))}
    </div>
  );
}
