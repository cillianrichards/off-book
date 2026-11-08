import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { STANDARD_FEN } from '@off-book/rules';

import { silentLog } from '../log.ts';
import { FakeSocket } from '../testing/fake-socket.ts';
import { FakeTime } from '../testing/fake-time.ts';
import { MemoryGameStore } from '../testing/memory-store.ts';
import { GameService } from './index.ts';

// Time stands still in these tests, so neither clock moves.
const FULL_CLOCKS = { white: 60_000, black: 60_000, running: false };

interface Table {
  readonly service: GameService;
  readonly store: MemoryGameStore;
  readonly time: FakeTime;
  readonly id: string;
  readonly white: FakeSocket;
  readonly black: FakeSocket;
  readonly whiteSays: (message: unknown) => void;
  readonly blackSays: (message: unknown) => void;
  /** Closes a player's socket, as a dropped connection does. */
  readonly leaves: (colour: 'white' | 'black') => void;
  /** Connects a player again on a new socket, returning it. */
  readonly returns: (colour: 'white' | 'black') => Promise<FakeSocket>;
}

/** A game with both players connected and their opening state messages already taken. */
async function table(initialFen = STANDARD_FEN, store = new MemoryGameStore()): Promise<Table> {
  const time = new FakeTime();
  const service = new GameService({ time, log: silentLog, store });
  const created = await service.create({
    white: 'alice',
    black: 'bob',
    initialFen,
    clock: { initialSeconds: 600, incrementSeconds: 0 },
  });
  assert.ok(created.ok);
  const sockets = { white: new FakeSocket(), black: new FakeSocket() };
  const says = async (user: string, socket: FakeSocket) => {
    const joined = await service.join(created.id, user);
    assert.ok(joined.ok);
    const connection = joined.attach(socket);
    connections.set(socket, connection);
    return (message: unknown) => connection.receive(JSON.stringify(message));
  };
  const connections = new Map<FakeSocket, { closed(): void }>();
  const whiteSays = await says('alice', sockets.white);
  const blackSays = await says('bob', sockets.black);
  sockets.white.take();
  sockets.black.take();
  const leaves = (colour: 'white' | 'black') => connections.get(sockets[colour])?.closed();
  const returns = async (colour: 'white' | 'black') => {
    const socket = new FakeSocket();
    await says(colour === 'white' ? 'alice' : 'bob', socket);
    return socket;
  };
  return { service, store, time, id: created.id, ...sockets, whiteSays, blackSays, leaves, returns };
}

describe('moves (P2-06)', () => {
  test('a move is sent to both players', async () => {
    const { white, black, whiteSays } = await table();
    whiteSays({ t: 'move', ply: 0, uci: 'e2e4' });
    const expected = {
      t: 'move',
      ply: 0,
      san: 'e4',
      uci: 'e2e4',
      fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
      clock: FULL_CLOCKS,
    };
    assert.deepEqual(white.take(), [expected]);
    assert.deepEqual(black.take(), [expected]);
  });

  test('an illegal or out-of-turn move is refused to its sender only', async () => {
    const { white, black, whiteSays, blackSays } = await table();
    blackSays({ t: 'move', ply: 0, uci: 'e7e5' });
    whiteSays({ t: 'move', ply: 0, uci: 'e2e5' });
    assert.deepEqual(black.take(), [{ t: 'rejected', reason: 'notYourTurn', ply: 0 }]);
    assert.deepEqual(white.take(), [{ t: 'rejected', reason: 'illegal', ply: 0 }]);
  });

  test('a resent move is acknowledged without being played again', async () => {
    const { white, black, whiteSays } = await table();
    whiteSays({ t: 'move', ply: 0, uci: 'e2e4' });
    white.take();
    black.take();
    whiteSays({ t: 'move', ply: 0, uci: 'e2e4' });
    assert.deepEqual(white.take(), [{ t: 'ack', ply: 0 }]);
    assert.deepEqual(black.take(), []);
  });

  test('a stale move is refused with the current ply', async () => {
    const { white, whiteSays } = await table();
    whiteSays({ t: 'move', ply: 2, uci: 'e2e4' });
    assert.deepEqual(white.take(), [{ t: 'rejected', reason: 'stale', ply: 0 }]);
  });

  test('checkmate ends the game for both players', async () => {
    const { service, id, white, black, whiteSays, blackSays } = await table();
    whiteSays({ t: 'move', ply: 0, uci: 'f2f3' });
    blackSays({ t: 'move', ply: 1, uci: 'e7e5' });
    whiteSays({ t: 'move', ply: 2, uci: 'g2g4' });
    blackSays({ t: 'move', ply: 3, uci: 'd8h4' });
    const end = { t: 'end', status: 'finished', result: '0-1', termination: 'checkmate', clock: FULL_CLOCKS };
    assert.deepEqual(white.of('end'), [end]);
    assert.deepEqual(black.of('end'), [end]);
    assert.equal((await service.view(id))?.status, 'finished');
    white.take();
    whiteSays({ t: 'move', ply: 4, uci: 'e1f2' });
    assert.deepEqual(white.take(), [{ t: 'rejected', reason: 'gameOver', ply: 4 }]);
  });
});

describe('abort', () => {
  test('a player who has not moved may abort, ending the game for both', async () => {
    const { white, black, whiteSays, blackSays } = await table();
    whiteSays({ t: 'move', ply: 0, uci: 'e2e4' });
    white.take();
    black.take();
    whiteSays({ t: 'abort' });
    assert.deepEqual(white.take(), [{ t: 'rejected', reason: 'notAllowed', ply: 1 }]);
    blackSays({ t: 'abort' });
    const end = { t: 'end', status: 'aborted', termination: 'aborted', clock: FULL_CLOCKS };
    assert.deepEqual(white.take(), [end]);
    assert.deepEqual(black.take(), [end]);
  });
});

describe('join', () => {
  test('refuses an unknown game and a stranger', async () => {
    const { service, id } = await table();
    assert.deepEqual(await service.join('ZZZZZZZZ', 'alice'), { ok: false, error: 'notFound' });
    assert.deepEqual(await service.join(id, 'carol'), { ok: false, error: 'notAPlayer' });
  });

  test('refuses to create an invalid game', async () => {
    const service = new GameService({ time: new FakeTime(), log: silentLog, store: new MemoryGameStore() });
    const created = await service.create({
      white: 'a',
      black: 'b',
      initialFen: 'nonsense',
      clock: { initialSeconds: 600, incrementSeconds: 0 },
    });
    assert.equal(created.ok, false);
  });
});

describe('flags found by the server (P2-07)', () => {
  test('ends the game when the side to move runs out, grace included', async () => {
    const { time, white, black, whiteSays, blackSays } = await table();
    whiteSays({ t: 'move', ply: 0, uci: 'e2e4' });
    blackSays({ t: 'move', ply: 1, uci: 'e7e5' });
    white.take();
    black.take();
    time.advance(601_999);
    assert.deepEqual(white.take(), []);
    time.advance(1);
    const end = {
      t: 'end',
      status: 'finished',
      result: '0-1',
      termination: 'flag',
      clock: { white: 0, black: 60_000, running: false },
    };
    assert.deepEqual(white.take(), [end]);
    assert.deepEqual(black.take(), [end]);
    assert.equal(time.pending, 0);
  });

  test('a move in time moves the check on to the other side', async () => {
    const { time, white, whiteSays, blackSays } = await table();
    whiteSays({ t: 'move', ply: 0, uci: 'e2e4' });
    blackSays({ t: 'move', ply: 1, uci: 'e7e5' });
    time.advance(300_000);
    whiteSays({ t: 'move', ply: 2, uci: 'g1f3' });
    white.take();
    time.advance(601_999);
    assert.deepEqual(white.of('end'), []);
    time.advance(1);
    assert.equal(white.of('end')[0]?.result, '1-0');
  });

  test('no check is left waiting once a game ends some other way', async () => {
    const { time, whiteSays, blackSays } = await table();
    for (const [ply, uci] of ['f2f3', 'e7e5', 'g2g4', 'd8h4'].entries()) {
      (ply % 2 === 0 ? whiteSays : blackSays)({ t: 'move', ply, uci });
    }
    assert.equal(time.pending, 0);
  });
});

describe('saving (P2-08)', () => {
  test('a new game is saved at once', async () => {
    const { store, id } = await table();
    assert.equal(store.saved(id)?.status, 'started');
    assert.deepEqual(store.saved(id)?.moves, []);
  });

  test('each side’s first move is saved at once, later moves within 30 seconds of the first unsaved one', async () => {
    const { service, store, time, id, whiteSays, blackSays } = await table();
    whiteSays({ t: 'move', ply: 0, uci: 'e2e4' });
    await service.settled();
    assert.deepEqual(store.saved(id)?.moves, ['e4']);
    blackSays({ t: 'move', ply: 1, uci: 'e7e5' });
    await service.settled();
    assert.deepEqual(store.saved(id)?.moves, ['e4', 'e5']);

    whiteSays({ t: 'move', ply: 2, uci: 'g1f3' });
    time.advance(20_000);
    blackSays({ t: 'move', ply: 3, uci: 'b8c6' });
    time.advance(9_999);
    await service.settled();
    assert.deepEqual(store.saved(id)?.moves, ['e4', 'e5'], 'nothing saved before the delay');
    time.advance(1);
    await service.settled();
    assert.deepEqual(
      store.saved(id)?.moves,
      ['e4', 'e5', 'Nf3', 'Nc6'],
      'a later move does not put the save off',
    );
  });

  test('the end of a game is saved at once', async () => {
    const { service, store, id, whiteSays, blackSays } = await table();
    whiteSays({ t: 'move', ply: 0, uci: 'f2f3' });
    blackSays({ t: 'move', ply: 1, uci: 'e7e5' });
    whiteSays({ t: 'move', ply: 2, uci: 'g2g4' });
    blackSays({ t: 'move', ply: 3, uci: 'd8h4' });
    await service.settled();
    const saved = store.saved(id);
    assert.equal(saved?.status, 'finished');
    assert.equal(saved?.result, '0-1');
    assert.equal(saved?.termination, 'checkmate');
    assert.equal(saved?.moves.length, 4);
  });

  test('a failed save is retried', async () => {
    const { service, store, time, id, whiteSays } = await table();
    store.failing = true;
    whiteSays({ t: 'move', ply: 0, uci: 'e2e4' });
    await service.settled();
    assert.deepEqual(store.saved(id)?.moves, []);
    store.failing = false;
    time.advance(30_000);
    await service.settled();
    assert.deepEqual(store.saved(id)?.moves, ['e4']);
  });
});

describe('restarting (P2-08)', () => {
  /** A game four plies in, White to move with the clock running since 25 seconds in. */
  async function underway() {
    const setup = await table();
    const { time, whiteSays, blackSays } = setup;
    whiteSays({ t: 'move', ply: 0, uci: 'e2e4' });
    blackSays({ t: 'move', ply: 1, uci: 'c7c5' });
    time.advance(10_000);
    whiteSays({ t: 'move', ply: 2, uci: 'g1f3' });
    time.advance(15_000);
    blackSays({ t: 'move', ply: 3, uci: 'd7d6' });
    await setup.service.settled();
    return setup;
  }

  const restarted = async (store: MemoryGameStore, time: FakeTime) => {
    const service = new GameService({ time, log: silentLog, store });
    await service.resume();
    return service;
  };

  const stateFor = async (service: GameService, id: string, user = 'alice') => {
    const joined = await service.join(id, user);
    assert.ok(joined.ok);
    const socket = new FakeSocket();
    joined.attach(socket);
    const [state] = socket.of('state');
    assert.ok(state);
    return { state, socket };
  };

  test('after a crash, a game resumes from its last save, losing the moves still waiting', async () => {
    const { service, store, time, id } = await underway();
    service.halt();
    const after = await restarted(store, time);
    const { state } = await stateFor(after, id);
    assert.deepEqual(state.game.moves, ['e4', 'c5']);
    assert.equal(state.game.turn, 'white');
  });

  test('after a crash, the time the server was down still runs on the clock', async () => {
    const { service, store, time, id } = await underway();
    time.advance(30_000);
    await service.settled();
    service.halt();
    time.advance(60_000);
    const after = await restarted(store, time);
    const { state } = await stateFor(after, id);
    // White's clock started 25 seconds in with 59,000 cs left; 90 seconds have passed since.
    assert.equal(state.game.clock.white, 59_000 - 9_000);
    assert.equal(state.game.clock.running, true);
  });

  test('a clean shutdown saves every game, giving the side to move 20 seconds and the other 10', async () => {
    const { service, store, time, id, white, whiteSays } = await underway();
    await service.shutdown();
    const saved = store.saved(id);
    assert.deepEqual(saved?.moves, ['e4', 'c5', 'Nf3', 'd6']);
    assert.deepEqual(saved?.remaining, { white: 59_000 + 2000, black: 58_500 + 1000 });
    assert.notEqual(saved?.clockRunningSince, null, 'the clock is saved running, so time away counts');

    white.take();
    whiteSays({ t: 'move', ply: 4, uci: 'd2d4' });
    assert.deepEqual(white.take(), [{ t: 'rejected', reason: 'restarting' }]);

    time.advance(5_000);
    const after = await restarted(store, time);
    const { state } = await stateFor(after, id);
    assert.equal(state.game.clock.white, 61_000 - 500);
    assert.equal(state.game.clock.black, 59_500);
  });

  test('a game whose clock ran out while the server was down is aborted just after the restart', async () => {
    const { service, store, time, id } = await underway();
    await service.shutdown();
    time.advance(700_000);
    await restarted(store, time);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(store.saved(id)?.status, 'aborted');
  });

  test('once the server has been up two minutes, running out of time is a loss again', async () => {
    const { service, store, time, id } = await underway();
    await service.shutdown();
    time.advance(100_000);
    const after = await restarted(store, time);
    // White had 610 seconds with the allowance; 100 have gone, so the flag falls 510 seconds after restart.
    time.advance(510_000 + 2_000);
    await after.settled();
    assert.equal(store.saved(id)?.termination, 'flag');
    assert.equal(store.saved(id)?.result, '0-1');
  });

  test('a finished game can still be joined after it has left memory', async () => {
    const { service, store, id, whiteSays } = await table();
    whiteSays({ t: 'abort' });
    await service.settled();
    const after = await restarted(store, new FakeTime());
    const { state } = await stateFor(after, id, 'bob');
    assert.equal(state.game.status, 'aborted');
    assert.equal((await after.view(id))?.status, 'aborted');
    assert.equal(await after.view('ZZZZZZZZ'), undefined);
  });
});

describe('reconnecting (P2-09)', () => {
  test('a client that asks is sent the whole game again', async () => {
    const { white, whiteSays, blackSays } = await table();
    whiteSays({ t: 'move', ply: 0, uci: 'e2e4' });
    blackSays({ t: 'move', ply: 1, uci: 'e7e5' });
    white.take();
    whiteSays({ t: 'resync' });
    const [state] = white.take();
    assert.equal(state?.t, 'state');
    assert.deepEqual(state?.t === 'state' && state.game.moves, ['e4', 'e5']);
    assert.equal(state?.t === 'state' && state.you, 'white');
  });
});

describe('abandonment (P2-10)', () => {
  // At 10+0, rapid, a player is gone after two minutes away.
  const GONE_MS = 120_000;

  async function underway() {
    const setup = await table();
    setup.whiteSays({ t: 'move', ply: 0, uci: 'e2e4' });
    setup.blackSays({ t: 'move', ply: 1, uci: 'e7e5' });
    setup.whiteSays({ t: 'move', ply: 2, uci: 'g1f3' });
    setup.white.take();
    setup.black.take();
    return setup;
  }

  test('a player is told when their opponent leaves, from when they may claim, and when they return', async () => {
    const { time, white, leaves, returns } = await underway();
    leaves('black');
    assert.deepEqual(white.take(), [{ t: 'opponent', connected: false, claimableAt: time.now() + GONE_MS }]);
    const back = await returns('black');
    assert.deepEqual(white.take(), [{ t: 'opponent', connected: true }]);
    const [state] = back.of('state');
    assert.deepEqual(state?.opponent, { connected: true });
  });

  test('the disconnected player’s clock keeps running', async () => {
    const { service, id, time, leaves } = await underway();
    leaves('black');
    time.advance(90_000);
    assert.equal((await service.view(id))?.clock.black, 60_000 - 9_000);
  });

  test('after the grace period the opponent may claim the win', async () => {
    const { service, store, id, time, white, whiteSays, leaves } = await underway();
    leaves('black');
    white.take();
    time.advance(GONE_MS - 1);
    whiteSays({ t: 'claim', outcome: 'win' });
    assert.deepEqual(white.take(), [{ t: 'rejected', reason: 'notClaimable', ply: 3 }]);
    time.advance(1);
    whiteSays({ t: 'claim', outcome: 'win' });
    const [end] = white.of('end');
    assert.deepEqual(end && { status: end.status, result: end.result, termination: end.termination }, {
      status: 'finished',
      result: '1-0',
      termination: 'abandonment',
    });
    await service.settled();
    assert.equal(store.saved(id)?.termination, 'abandonment');
  });

  test('or a draw', async () => {
    const { time, white, whiteSays, leaves } = await underway();
    leaves('black');
    time.advance(GONE_MS);
    whiteSays({ t: 'claim', outcome: 'draw' });
    assert.equal(white.of('end')[0]?.result, '1/2-1/2');
  });

  test('only on the gone player’s turn', async () => {
    const { time, black, blackSays, leaves } = await underway();
    leaves('white');
    black.take();
    time.advance(GONE_MS);
    blackSays({ t: 'claim', outcome: 'win' });
    assert.deepEqual(black.take(), [{ t: 'rejected', reason: 'notClaimable', ply: 3 }]);
  });

  test('not while the opponent is connected', async () => {
    const { time, white, whiteSays } = await underway();
    time.advance(GONE_MS * 2);
    whiteSays({ t: 'claim', outcome: 'win' });
    assert.deepEqual(white.of('rejected'), [{ t: 'rejected', reason: 'notClaimable', ply: 3 }]);
  });

  test('and not before both sides have moved', async () => {
    const { time, white, whiteSays, leaves } = await table();
    whiteSays({ t: 'move', ply: 0, uci: 'e2e4' });
    leaves('black');
    white.take();
    time.advance(GONE_MS);
    whiteSays({ t: 'claim', outcome: 'win' });
    assert.deepEqual(white.take(), [{ t: 'rejected', reason: 'notClaimable', ply: 1 }]);
  });
});
