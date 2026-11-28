// The moves so far (P2-15), numbered from the starting FEN. A strip across the top of a phone screen, a
// column beside the board on a wider one, as lila lays them out; it keeps the latest move in view.

import { useEffect, useRef } from 'react';

import { numberedMoves } from './round.ts';

export function MoveList({
  initialFen,
  moves,
}: {
  readonly initialFen: string;
  readonly moves: readonly string[];
}) {
  const list = useRef<HTMLOListElement>(null);
  useEffect(() => {
    list.current?.lastElementChild?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [moves.length]);

  const rows = numberedMoves(initialFen, moves);
  const last = moves.length - 1;
  let ply = 0;
  return (
    <ol ref={list} className="moves" aria-label="Moves">
      {rows.map(row => {
        const white = row.white === undefined ? undefined : ply++;
        const black = row.black === undefined ? undefined : ply++;
        return (
          <li key={row.number} className="move-row">
            <span className="move-number">{row.number}.</span>
            <span className={white === last ? 'move current' : 'move'}>{row.white ?? '…'}</span>
            {row.black !== undefined && (
              <span className={black === last ? 'move current' : 'move'}>{row.black}</span>
            )}
          </li>
        );
      })}
    </ol>
  );
}
