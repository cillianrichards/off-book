// The game page's parts (P2-15), rendered through Vite as the shell's test renders pages, since Node cannot
// load TSX. The board's behaviour lives in round.ts and board-config.ts, tested on their own.

import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer, type ViteDevServer } from 'vite';

import { STANDARD_FEN } from '@off-book/rules';
import type { GameView } from '@off-book/protocol';

import { boardConfig } from './board-config.ts';
import { playMove, positionOf, roundFromState } from './round.ts';

const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const BLACK_TO_MOVE = 'r1bqkb1r/pp1n1ppp/2p1pn2/3p2B1/2PP4/2N1PN2/PP3PPP/R2QKB1R b KQkq - 1 6';

describe('the game page’s parts', () => {
  let vite: ViteDevServer;
  let MoveList: typeof import('./MoveList.tsx').MoveList;
  let Promotion: typeof import('./Promotion.tsx').Promotion;

  before(async () => {
    vite = await createServer({ root, logLevel: 'silent', server: { middlewareMode: true, hmr: false } });
    ({ MoveList } = (await vite.ssrLoadModule('/src/game/MoveList.tsx')) as typeof import('./MoveList.tsx'));
    ({ Promotion } = (await vite.ssrLoadModule(
      '/src/game/Promotion.tsx',
    )) as typeof import('./Promotion.tsx'));
  });

  after(async () => {
    await vite.close();
  });

  test('the move list numbers from the FEN and marks the latest move', () => {
    const html = renderToStaticMarkup(
      createElement(MoveList, { initialFen: BLACK_TO_MOVE, moves: ['Qa5', 'Nd2', 'Bb4'] }),
    );
    assert.match(
      html,
      /<span class="move-number">6\.<\/span><span class="move">…<\/span><span class="move">Qa5<\/span>/,
    );
    assert.match(
      html,
      /<span class="move-number">7\.<\/span><span class="move">Nd2<\/span><span class="move current">Bb4<\/span>/,
    );
  });

  test('the promotion picker offers four pieces down the promotion file, in the player’s colour', () => {
    const noop = () => {};
    const html = renderToStaticMarkup(
      createElement(Promotion, {
        square: 'c8',
        colour: 'white',
        orientation: 'white',
        onChoose: noop,
        onCancel: noop,
      }),
    );
    for (const role of ['queen', 'knight', 'rook', 'bishop'])
      assert.match(html, new RegExp(`<piece class="${role} white">`));
    assert.match(html, /aria-label="queen" style="left:25%;top:0%"/);
    assert.match(html, /aria-label="bishop" style="left:25%;top:37.5%"/);
    // Seen from Black's side, White's promotion square is at the bottom, and files run the other way.
    const flipped = renderToStaticMarkup(
      createElement(Promotion, {
        square: 'c8',
        colour: 'white',
        orientation: 'black',
        onChoose: noop,
        onCancel: noop,
      }),
    );
    assert.match(flipped, /aria-label="queen" style="left:62.5%;bottom:0%"/);
  });
});

describe('the board’s configuration', () => {
  const game = (overrides: Partial<GameView> = {}): GameView => ({
    id: 'abcd1234',
    players: { white: 'alice', black: 'bob' },
    initialFen: STANDARD_FEN,
    fen: STANDARD_FEN,
    moves: [],
    ply: 0,
    turn: 'white',
    status: 'started',
    clock: { initialSeconds: 600, incrementSeconds: 0, white: 60_000, black: 60_000, running: false },
    ...overrides,
  });
  const configFor = (round: ReturnType<typeof roundFromState>) => boardConfig(round, positionOf(round));

  test('faces the player, and lets them move only their own pieces', () => {
    const config = configFor(
      roundFromState({ t: 'state', you: 'black', game: game(), opponent: { connected: true } }),
    );
    assert.equal(config.orientation, 'black');
    assert.equal(config.turnColor, 'white');
    assert.equal(config.movable?.color, 'black', 'set on the opponent’s turn, so a move becomes a premove');
    assert.equal(config.movable?.dests?.size, 0);
    assert.equal(config.premovable?.enabled, true);
  });

  test('shows the last move, a check, and the player’s legal moves on their turn', () => {
    const round = roundFromState({
      t: 'state',
      you: 'white',
      game: game({ moves: ['e4', 'f5', 'Qh5+'], ply: 3, turn: 'black' }),
      opponent: { connected: true },
    });
    const black = configFor({ ...round, you: 'black' });
    assert.deepEqual(black.lastMove, ['d1', 'h5']);
    assert.equal(black.check, true);
    assert.deepEqual(black.movable?.dests?.get('g7'), ['g6']);
  });

  test('shows the player’s own move at once while the server confirms it', () => {
    const sent = playMove(
      roundFromState({ t: 'state', you: 'white', game: game(), opponent: { connected: true } }),
      'e2',
      'e4',
    );
    assert.ok(sent);
    const config = configFor(sent.round);
    assert.equal(config.fen, 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1');
    assert.deepEqual(config.lastMove, ['e2', 'e4']);
  });

  test('allows nothing once the game is over', () => {
    const config = configFor(
      roundFromState({
        t: 'state',
        you: 'white',
        game: game({ status: 'finished', result: '0-1', termination: 'flag' }),
        opponent: { connected: true },
      }),
    );
    assert.equal(config.movable?.color, undefined);
    assert.equal(config.premovable?.enabled, false);
    assert.equal(config.draggable?.enabled, false);
  });
});
