import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { STANDARD_FEN } from '@off-book/rules';

import { LiveGame, type MoveOutcome } from './live-game.ts';

const NOW = Date.UTC(2026, 10, 8, 12);
const TEN_PLUS_ZERO = { initialSeconds: 600, incrementSeconds: 0 };

const newGame = (initialFen = STANDARD_FEN): LiveGame => {
  const created = LiveGame.create({
    id: 'abcd1234',
    white: 'alice',
    black: 'bob',
    initialFen,
    clock: TEN_PLUS_ZERO,
    now: NOW,
  });
  assert.ok(created.ok, created.ok ? '' : created.error);
  return created.game;
};

/** Plays moves alternately from the side to move, each at the current ply. */
const play = (game: LiveGame, ucis: readonly string[]): MoveOutcome[] =>
  ucis.map(uci => {
    const outcome = game.move(game.turn, { ply: game.ply, uci }, NOW);
    assert.equal(outcome.kind, 'moved', `${uci} should be played`);
    return outcome;
  });

describe('LiveGame.create', () => {
  test('starts a game from any FEN', () => {
    const game = newGame('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1');
    assert.equal(game.status, 'started');
    assert.equal(game.turn, 'black');
    assert.equal(game.view(NOW).initialFen, 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1');
  });

  test('refuses one player on both sides, a bad clock and a bad FEN', () => {
    const base = {
      id: 'abcd1234',
      white: 'alice',
      black: 'bob',
      initialFen: STANDARD_FEN,
      clock: TEN_PLUS_ZERO,
      now: NOW,
    };
    assert.equal(LiveGame.create({ ...base, black: 'alice' }).ok, false);
    assert.equal(LiveGame.create({ ...base, clock: { initialSeconds: 0, incrementSeconds: 0 } }).ok, false);
    assert.equal(
      LiveGame.create({ ...base, clock: { initialSeconds: 600.5, incrementSeconds: 0 } }).ok,
      false,
    );
    assert.equal(
      LiveGame.create({ ...base, clock: { initialSeconds: 600, incrementSeconds: 181 } }).ok,
      false,
    );
    assert.equal(LiveGame.create({ ...base, initialFen: '8/8/8/8/8/8/8/4K3 w - - 0 1' }).ok, false);
  });
});

describe('move (P2-06)', () => {
  test('plays a legal move by the side to move, in SAN and UCI', () => {
    const game = newGame();
    assert.deepEqual(game.move('white', { ply: 0, uci: 'e2e4' }, NOW), {
      kind: 'moved',
      ply: 0,
      san: 'e4',
      uci: 'e2e4',
      fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
    });
    assert.equal(game.ply, 1);
    assert.equal(game.turn, 'black');
    assert.equal(game.lastMoveAt, NOW);
  });

  test('rejects a move out of turn', () => {
    const game = newGame();
    assert.deepEqual(game.move('black', { ply: 0, uci: 'e7e5' }, NOW), {
      kind: 'rejected',
      reason: 'notYourTurn',
    });
    assert.equal(game.ply, 0);
  });

  test('rejects an illegal move, a malformed one and a missing promotion piece', () => {
    const game = newGame();
    assert.deepEqual(game.move('white', { ply: 0, uci: 'e2e5' }, NOW), {
      kind: 'rejected',
      reason: 'illegal',
    });
    assert.deepEqual(game.move('white', { ply: 0, uci: 'e2' }, NOW), { kind: 'rejected', reason: 'illegal' });
    assert.deepEqual(game.move('white', { ply: 0, uci: 'e2e4q' }, NOW), {
      kind: 'rejected',
      reason: 'illegal',
    });
    const promoting = newGame('8/4P3/8/8/8/k7/8/4K3 w - - 0 1');
    assert.deepEqual(promoting.move('white', { ply: 0, uci: 'e7e8' }, NOW), {
      kind: 'rejected',
      reason: 'illegal',
    });
    assert.equal(promoting.move('white', { ply: 0, uci: 'e7e8q' }, NOW).kind, 'moved');
    assert.equal(game.ply, 0);
  });

  test('treats the same move resent for a ply already played as a duplicate, changing nothing', () => {
    const game = newGame();
    play(game, ['e2e4', 'e7e5']);
    assert.deepEqual(game.move('white', { ply: 0, uci: 'e2e4' }, NOW), { kind: 'duplicate', ply: 0 });
    assert.deepEqual(game.move('black', { ply: 1, uci: 'e7e5' }, NOW), { kind: 'duplicate', ply: 1 });
    assert.equal(game.ply, 2);
  });

  test('rejects as stale anything else meant for another ply', () => {
    const game = newGame();
    play(game, ['e2e4', 'e7e5']);
    assert.deepEqual(game.move('white', { ply: 0, uci: 'd2d4' }, NOW), { kind: 'rejected', reason: 'stale' });
    assert.deepEqual(game.move('black', { ply: 0, uci: 'e2e4' }, NOW), { kind: 'rejected', reason: 'stale' });
    assert.deepEqual(game.move('white', { ply: 3, uci: 'g1f3' }, NOW), { kind: 'rejected', reason: 'stale' });
    assert.equal(game.ply, 2);
  });

  test('ends the game on checkmate, with the winner', () => {
    const game = newGame();
    const [, , , mate] = play(game, ['f2f3', 'e7e5', 'g2g4', 'd8h4']);
    assert.deepEqual(mate, {
      kind: 'moved',
      ply: 3,
      san: 'Qh4#',
      uci: 'd8h4',
      fen: 'rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3',
      ending: { status: 'finished', result: '0-1', termination: 'checkmate' },
    });
    assert.equal(game.status, 'finished');
    assert.equal(game.finishedAt, NOW);
    assert.deepEqual(game.move('white', { ply: 4, uci: 'e1f2' }, NOW), {
      kind: 'rejected',
      reason: 'gameOver',
    });
  });

  test('ends the game in a draw on an automatic draw', () => {
    const game = newGame('7k/8/6K1/8/8/8/8/5Q2 w - - 0 1');
    const [stalemate] = play(game, ['f1f7']);
    assert.deepEqual(stalemate?.kind === 'moved' && stalemate.ending, {
      status: 'finished',
      result: '1/2-1/2',
      termination: 'stalemate',
    });
    assert.equal(game.view(NOW).result, '1/2-1/2');
    assert.equal(game.view(NOW).termination, 'stalemate');
  });
});

describe('abort', () => {
  test('either player may abort before anyone has moved', () => {
    assert.deepEqual(newGame().abort('white', NOW), { status: 'aborted', termination: 'aborted' });
    assert.deepEqual(newGame().abort('black', NOW), { status: 'aborted', termination: 'aborted' });
  });

  test('only a player who has not yet moved may abort', () => {
    const game = newGame();
    play(game, ['e2e4']);
    assert.equal(game.abort('white', NOW), undefined);
    assert.deepEqual(game.abort('black', NOW), { status: 'aborted', termination: 'aborted' });
    assert.equal(game.status, 'aborted');
    assert.equal(game.view(NOW).result, undefined);
  });

  test('nobody may abort once both have moved', () => {
    const game = newGame();
    play(game, ['e2e4', 'e7e5']);
    assert.equal(game.abort('white', NOW), undefined);
    assert.equal(game.abort('black', NOW), undefined);
    assert.equal(game.status, 'started');
  });

  test('from a Black-to-move start, Black moves first', () => {
    const game = newGame('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1');
    play(game, ['e7e5']);
    assert.equal(game.movesBy('black'), 1);
    assert.equal(game.movesBy('white'), 0);
    assert.equal(game.abort('black', NOW), undefined);
    assert.ok(game.abort('white', NOW));
  });
});
