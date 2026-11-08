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
      clock: { white: 60_000, black: 60_000, running: false },
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
      clock: { white: 60_000, black: 60_000, running: false },
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

describe('clocks (P2-07)', () => {
  // 10+0: 60,000 centiseconds each.
  const at = (seconds: number) => NOW + seconds * 1000;

  test('do not run until each side has moved once', () => {
    const game = newGame();
    game.move('white', { ply: 0, uci: 'e2e4' }, at(30));
    const second = game.move('black', { ply: 1, uci: 'e7e5' }, at(70));
    assert.equal(second.kind === 'moved' && second.clock.running, true);
    assert.deepEqual(game.clockAt(at(70)), { white: 60_000, black: 60_000, running: true });
    assert.equal(game.clockAt(at(80)).white, 59_000);
  });

  test('time each move on the server’s receipt and record each side’s history', () => {
    const game = newGame();
    play(game, ['e2e4', 'e7e5']);
    game.move('white', { ply: 2, uci: 'g1f3' }, at(12.34));
    game.move('black', { ply: 3, uci: 'b8c6' }, at(20.34));
    assert.deepEqual(game.clockAt(at(20.34)), { white: 60_000 - 1234, black: 60_000 - 800, running: true });
    assert.deepEqual(game.clockHistory, { white: [60_000, 60_000 - 1234], black: [60_000, 60_000 - 800] });
  });

  test('give back reported lag, within the quota', () => {
    const game = newGame();
    play(game, ['e2e4', 'e7e5']);
    game.move('white', { ply: 2, uci: 'g1f3', lagMs: 400 }, at(5));
    assert.equal(game.clockAt(at(5)).white, 60_000 - 500 + 40);
  });

  test('a move arriving after its player ran out of time is not played, and loses on time', () => {
    const game = newGame();
    play(game, ['e2e4', 'e7e5']);
    assert.deepEqual(game.move('white', { ply: 2, uci: 'g1f3' }, at(601)), { kind: 'flagged' });
    assert.equal(game.ply, 2);
    assert.deepEqual(game.flag(at(601)), { status: 'finished', result: '0-1', termination: 'flag' });
    assert.deepEqual(game.clockAt(at(700)), { white: 0, black: 60_000, running: false });
  });

  test('the side to move is out of time only after the grace', () => {
    const game = newGame();
    play(game, ['e2e4', 'e7e5']);
    // White's quota starts at 3 seconds, so the grace is the 2-second maximum.
    assert.equal(game.flagCheckDueAt, at(602));
    assert.equal(game.isOutOfTime(at(601.99)), false);
    assert.equal(game.isOutOfTime(at(602)), true);
    game.flag(at(602));
    assert.equal(game.flagCheckDueAt, undefined);
    assert.equal(game.isOutOfTime(at(700)), false, 'a finished game is not out of time');
  });

  test('a flag against a side that cannot mate is a draw', () => {
    // White has king and queen, Black king and knight, which cannot mate a queen.
    const game = newGame('7k/8/6Q1/8/3K4/8/1n6/8 w - - 0 1');
    play(game, ['d4e4', 'b2d1']);
    assert.deepEqual(game.flag(at(602)), { status: 'finished', result: '1/2-1/2', termination: 'flag' });
  });

  test('time can be given to either side', () => {
    const game = newGame();
    play(game, ['e2e4', 'e7e5']);
    game.giveTime('white', 2000);
    game.giveTime('black', 1000);
    assert.deepEqual(game.clockAt(at(10)), { white: 61_000, black: 61_000, running: true });
  });

  test('a game can be aborted after a restart, whoever has moved', () => {
    const game = newGame();
    play(game, ['e2e4', 'e7e5', 'g1f3']);
    assert.deepEqual(game.abortAfterRestart(at(700)), { status: 'aborted', termination: 'aborted' });
    assert.equal(game.clockAt(at(800)).running, false);
  });

  test('the view counts the running clock down', () => {
    const game = newGame();
    play(game, ['e2e4', 'e7e5']);
    assert.deepEqual(game.view(at(90)).clock, {
      initialSeconds: 600,
      incrementSeconds: 0,
      white: 51_000,
      black: 60_000,
      running: true,
    });
  });
});

describe('saving and restoring (P2-08)', () => {
  const at = (seconds: number) => NOW + seconds * 1000;
  const playedTo = (game: LiveGame): LiveGame => {
    game.move('white', { ply: 0, uci: 'e2e4' }, at(1));
    game.move('black', { ply: 1, uci: 'c7c5' }, at(2));
    game.move('white', { ply: 2, uci: 'g1f3' }, at(10));
    game.move('black', { ply: 3, uci: 'd7d6' }, at(25));
    return game;
  };

  test('a game in play comes back exactly, and play goes on', () => {
    const game = playedTo(newGame());
    const record = game.toRecord();
    const restored = LiveGame.restore(record);
    assert.deepEqual(restored.toRecord(), record);
    assert.deepEqual(restored.view(at(40)), game.view(at(40)));
    assert.equal(restored.move('white', { ply: 4, uci: 'd2d4' }, at(41)).kind, 'moved');
  });

  test('a running clock keeps running from when it started, so time away counts', () => {
    const restored = LiveGame.restore(playedTo(newGame()).toRecord());
    // White's clock started at 25 s with 59,200 cs left; at 125 s it has used another 100 s.
    assert.equal(restored.clockAt(at(125)).white, 59_200 - 10_000);
  });

  test('a finished or aborted game comes back over', () => {
    const finished = newGame();
    play(finished, ['f2f3', 'e7e5', 'g2g4', 'd8h4']);
    assert.deepEqual(LiveGame.restore(finished.toRecord()).ending, {
      status: 'finished',
      result: '0-1',
      termination: 'checkmate',
    });
    const aborted = newGame();
    aborted.abort('white', NOW);
    assert.equal(LiveGame.restore(aborted.toRecord()).status, 'aborted');
  });

  test('a Black-to-move start still knows Black moved first', () => {
    const game = newGame('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1');
    play(game, ['e7e5']);
    const restored = LiveGame.restore(game.toRecord());
    assert.equal(restored.abort('black', NOW), undefined);
    assert.ok(restored.abort('white', NOW));
  });

  test('a record whose moves will not replay is corrupt, and throws', () => {
    const record = playedTo(newGame()).toRecord();
    assert.throws(() => LiveGame.restore({ ...record, moves: ['e4', 'e4'] }), /not legal/);
  });
});
