import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { STANDARD_FEN } from '@off-book/rules';

import { GameService } from './game/index.ts';
import { silentLog } from './log.ts';
import { type RunningServer, startServer } from './server.ts';
import { openClient, type TestClient } from './testing/client.ts';
import { MemoryGameStore } from './testing/memory-store.ts';
import { testAuthenticate as authenticate } from './testing/test-auth.ts';
import { realTime } from './time.ts';

let server: RunningServer;
let games: GameService;
let gameId: string;
let base: string;

before(async () => {
  games = new GameService({ time: realTime, log: silentLog, store: new MemoryGameStore() });
  server = await startServer({ port: 0, host: '127.0.0.1', games, authenticate, log: silentLog });
  base = `127.0.0.1:${server.port}`;
  const created = await games.create({
    white: 'alice',
    black: 'bob',
    initialFen: STANDARD_FEN,
    clock: { initialSeconds: 600, incrementSeconds: 0 },
  });
  assert.ok(created.ok);
  gameId = created.id;
});

after(() => server.close());

const connectAs = async (user: string, id = gameId): Promise<TestClient> => {
  const opened = await openClient(`ws://${base}/play/${id}`, { 'x-test-user': user });
  assert.ok(opened.ok, `expected ${user} to connect`);
  return opened.client;
};

describe('HTTP', () => {
  test('answers the health check', async () => {
    const response = await fetch(`http://${base}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok' });
  });

  test('shows a game to anyone', async () => {
    const response = await fetch(`http://${base}/api/games/${gameId}`);
    assert.equal(response.status, 200);
    const view = (await response.json()) as { id: string; initialFen: string; moves: string[] };
    assert.equal(view.id, gameId);
    assert.equal(view.initialFen, STANDARD_FEN);
    assert.deepEqual(view.moves, []);
  });

  test('answers 404 for an unknown game or path, and 405 for other methods', async () => {
    assert.equal((await fetch(`http://${base}/api/games/ZZZZZZZZ`)).status, 404);
    assert.equal((await fetch(`http://${base}/api/games/not-an-id`)).status, 404);
    assert.equal((await fetch(`http://${base}/nowhere`)).status, 404);
    assert.equal((await fetch(`http://${base}/health`, { method: 'POST' })).status, 405);
  });
});

describe('WebSocket', () => {
  test('refuses an unidentified user, a stranger, an unknown game and an unknown path', async () => {
    assert.deepEqual(await openClient(`ws://${base}/play/${gameId}`), { ok: false, status: 401 });
    assert.deepEqual(await openClient(`ws://${base}/play/${gameId}`, { 'x-test-user': 'carol' }), {
      ok: false,
      status: 403,
    });
    assert.deepEqual(await openClient(`ws://${base}/play/ZZZZZZZZ`, { 'x-test-user': 'alice' }), {
      ok: false,
      status: 404,
    });
    assert.deepEqual(await openClient(`ws://${base}/elsewhere`, { 'x-test-user': 'alice' }), {
      ok: false,
      status: 404,
    });
  });

  test('sends a player the game and their colour as soon as they connect', async () => {
    const black = await connectAs('bob');
    const state = await black.nextOf('state');
    assert.equal(state.you, 'black');
    assert.equal(state.game.id, gameId);
    assert.equal(state.game.turn, 'white');
    await black.close();
  });

  test('answers a ping, and rejects what it cannot read', async () => {
    const white = await connectAs('alice');
    await white.nextOf('state');
    white.send({ t: 'ping' });
    assert.deepEqual(await white.next(), { t: 'pong' });
    white.sendText('not json');
    assert.deepEqual(await white.next(), { t: 'rejected', reason: 'badMessage' });
    white.send({ t: 'teleport' });
    assert.deepEqual(await white.next(), { t: 'rejected', reason: 'badMessage' });
    await white.close();
  });

  test('two players play a game to the end over their sockets', async () => {
    const created = await games.create({
      white: 'alice',
      black: 'bob',
      initialFen: STANDARD_FEN,
      clock: { initialSeconds: 600, incrementSeconds: 0 },
    });
    assert.ok(created.ok);
    const white = await connectAs('alice', created.id);
    const black = await connectAs('bob', created.id);
    await white.nextOf('state');
    await black.nextOf('state');
    const moves: [TestClient, string][] = [
      [white, 'f2f3'],
      [black, 'e7e5'],
      [white, 'g2g4'],
      [black, 'd8h4'],
    ];
    for (const [ply, [player, uci]] of moves.entries()) {
      player.send({ t: 'move', ply, uci });
      assert.equal((await white.nextOf('move')).uci, uci);
      assert.equal((await black.nextOf('move')).uci, uci);
    }
    for (const player of [white, black]) {
      const { status, result, termination } = await player.nextOf('end');
      assert.deepEqual(
        { status, result, termination },
        { status: 'finished', result: '0-1', termination: 'checkmate' },
      );
    }
    await Promise.all([white.close(), black.close()]);
  });

  test('closing the server tells clients it is restarting', async () => {
    const own = new GameService({ time: realTime, log: silentLog, store: new MemoryGameStore() });
    const created = await own.create({
      white: 'a',
      black: 'b',
      initialFen: STANDARD_FEN,
      clock: { initialSeconds: 60, incrementSeconds: 0 },
    });
    assert.ok(created.ok);
    const running = await startServer({
      port: 0,
      host: '127.0.0.1',
      games: own,
      authenticate,
      log: silentLog,
    });
    const opened = await openClient(`ws://127.0.0.1:${running.port}/play/${created.id}`, {
      'x-test-user': 'a',
    });
    assert.ok(opened.ok);
    await running.close();
    assert.equal(await opened.client.closedBy, 1012);
  });
});
