// A player's game (P2-15): the board, the players, the moves, connected to the server over the game's
// WebSocket. Everything shown comes from the round, which is rebuilt from the server's messages; the page
// only carries out the effects the round asks for. Clocks are P2-16 and the result screen P2-17.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { Api } from '@lichess-org/chessground/api';
import type { Key, MoveMetadata } from '@lichess-org/chessground/types';
import type { Colour, Promotion as Piece, Square } from '@off-book/rules';

import { Board } from './Board.tsx';
import { boardConfig } from './board-config.ts';
import { connectToGame, type ConnectionStatus, type GameConnection, gameSocketUrl } from './connection.ts';
import { MoveList } from './MoveList.tsx';
import { Promotion } from './Promotion.tsx';
import {
  applyMessage,
  type Effect,
  needsPromotion,
  playMove,
  positionOf,
  type Round,
  roundFromState,
} from './round.ts';
import { play } from './sound.ts';

export function GamePage({ id }: { readonly id: string }) {
  const [round, setRound] = useState<Round | undefined>(undefined);
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [promoting, setPromoting] = useState<{ from: Square; to: Square } | undefined>(undefined);
  const latest = useRef<Round | undefined>(undefined);
  const connection = useRef<GameConnection | undefined>(undefined);
  const board = useRef<Api | undefined>(undefined);

  const update = useCallback((next: Round) => {
    latest.current = next;
    setRound(next);
  }, []);

  const run = useCallback((effects: readonly Effect[], next: Round) => {
    for (const effect of effects) {
      if (effect.type === 'sound') play(effect.sound);
      else if (effect.type === 'send') connection.current?.send(effect.message);
      else if (board.current !== undefined) {
        // The board must show the opponent's move before a premove can be played on it.
        board.current.set(boardConfig(next, positionOf(next)));
        board.current.playPremove();
      }
    }
  }, []);

  useEffect(() => {
    const opened = connectToGame({
      url: gameSocketUrl(location, id),
      onStatus: setStatus,
      onMessage: message => {
        const current = latest.current;
        if (current === undefined) {
          if (message.t === 'state') update(roundFromState(message));
          return;
        }
        const { round: next, effects } = applyMessage(current, message);
        if (next !== current) update(next);
        run(effects, next);
      },
    });
    connection.current = opened;
    return () => opened.close();
  }, [id, update, run]);

  const send = useCallback(
    (from: Square, to: Square, promotion?: Piece) => {
      const current = latest.current;
      if (current === undefined) return;
      const sent = playMove(current, from, to, promotion);
      if (sent === undefined) {
        // Not a move the server would take: put the board back as the round has it.
        board.current?.set(boardConfig(current, positionOf(current)));
        return;
      }
      update(sent.round);
      connection.current?.send(sent.message);
    },
    [update],
  );

  const onMove = useCallback(
    (from: Key, to: Key, metadata: MoveMetadata) => {
      const current = latest.current;
      if (current === undefined) return;
      const [orig, dest] = [from as Square, to as Square];
      if (!metadata.premove) play(metadata.captured === undefined ? 'move' : 'capture');
      if (needsPromotion(current, orig, dest)) {
        // A premove promotes to a queen, as lila does by default; otherwise the player chooses.
        if (metadata.premove) send(orig, dest, 'q');
        else setPromoting({ from: orig, to: dest });
        return;
      }
      send(orig, dest);
    },
    [send],
  );

  const position = useMemo(() => (round === undefined ? undefined : positionOf(round)), [round]);
  const config = useMemo(
    () => (round === undefined || position === undefined ? undefined : boardConfig(round, position)),
    [round, position],
  );

  if (round === undefined || position === undefined || config === undefined) {
    return <p className="muted">{status === 'reconnecting' ? 'Reconnecting…' : 'Connecting…'}</p>;
  }

  const opponent: Colour = round.you === 'white' ? 'black' : 'white';
  return (
    <div className="game">
      <div className="game-board">
        <Player name={round.game.players[opponent]} colour={opponent} connected={round.opponent.connected} />
        <Board
          config={config}
          onMove={onMove}
          onReady={api => (board.current = api)}
          overlay={
            promoting !== undefined && (
              <Promotion
                square={promoting.to}
                colour={round.you}
                orientation={round.you}
                onChoose={piece => {
                  setPromoting(undefined);
                  send(promoting.from, promoting.to, piece);
                }}
                onCancel={() => {
                  setPromoting(undefined);
                  board.current?.set(boardConfig(round, position));
                }}
              />
            )
          }
        />
        <Player name={round.game.players[round.you]} colour={round.you} connected={status === 'open'} />
      </div>
      <aside className="game-side">
        <MoveList initialFen={round.game.initialFen} moves={position.moves} />
        {status === 'reconnecting' && <p className="muted">Reconnecting…</p>}
        {!position.playing && <p className="game-over">Game over</p>}
      </aside>
    </div>
  );
}

function Player({ name, colour, connected }: { name: string; colour: Colour; connected: boolean }) {
  return (
    <div className="player">
      <span
        className={`player-dot ${connected ? 'online' : 'offline'}`}
        aria-label={connected ? 'online' : 'offline'}
      />
      <span className="player-name">{name}</span>
      <span className="muted">{colour}</span>
    </div>
  );
}
