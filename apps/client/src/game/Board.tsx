// chessground in React (P2-15): created once on mount, then reconfigured whenever the page passes a new
// configuration. The page reaches the board's API through `onReady`, to play premoves and to undo a move
// the board made before a promotion piece was chosen. An overlay, such as the promotion picker, is drawn
// inside chessground's own container, as lila draws it, so it matches the board square for square even
// when chessground rounds the board to whole pixels.

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { Chessground } from '@lichess-org/chessground';
import type { Api } from '@lichess-org/chessground/api';
import type { Config } from '@lichess-org/chessground/config';
import type { Key, MoveMetadata } from '@lichess-org/chessground/types';

export interface BoardProps {
  readonly config: Config;
  readonly onMove: (from: Key, to: Key, metadata: MoveMetadata) => void;
  readonly onReady?: (api: Api) => void;
  readonly overlay?: React.ReactNode;
}

export function Board({ config, onMove, onReady, overlay }: BoardProps) {
  const element = useRef<HTMLDivElement>(null);
  const [container, setContainer] = useState<Element | null>(null);
  const api = useRef<Api | undefined>(undefined);
  // The latest handler, so chessground's event, bound once, always calls the current one.
  const move = useRef(onMove);
  move.current = onMove;

  useEffect(() => {
    if (element.current === null) return () => {};
    const board = Chessground(element.current, {
      ...config,
      coordinates: true,
      animation: { enabled: true, duration: 200 },
      movable: {
        ...config.movable,
        events: { after: (from, to, metadata) => move.current(from, to, metadata) },
      },
    });
    api.current = board;
    setContainer(element.current.querySelector('cg-container'));
    onReady?.(board);
    return () => {
      board.destroy();
      api.current = undefined;
      setContainer(null);
    };
    // Created once; later configurations go through `set` below.
  }, []);

  useEffect(() => {
    api.current?.set(config);
  }, [config]);

  return (
    <div className="board">
      <div ref={element} className="board-ground" />
      {container !== null && overlay !== undefined && createPortal(overlay, container)}
    </div>
  );
}
