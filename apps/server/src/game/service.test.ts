import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { STANDARD_FEN } from '@off-book/rules';

import { silentLog } from '../log.ts';
import { FakeSocket } from '../testing/fake-socket.ts';
import { FakeTime } from '../testing/fake-time.ts';
import { GameService } from './index.ts';

interface Table {
  readonly service: GameService;
  readonly time: FakeTime;
  readonly id: string;
  readonly white: FakeSocket;
  readonly black: FakeSocket;
  readonly whiteSays: (message: unknown) => void;
  readonly blackSays: (message: unknown) => void;
}

/** A game with both players connected and their opening state messages already taken. */
async function table(initialFen = STANDARD_FEN): Promise<Table> {
  const time = new FakeTime();
  const service = new GameService({ time, log: silentLog });
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
    socket.take();
    return (message: unknown) => connection.receive(JSON.stringify(message));
  };
  const whiteSays = await says('alice', sockets.white);
  const blackSays = await says('bob', sockets.black);
  return { service, time, id: created.id, ...sockets, whiteSays, blackSays };
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
    const end = { t: 'end', status: 'finished', result: '0-1', termination: 'checkmate' };
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
    const end = { t: 'end', status: 'aborted', termination: 'aborted' };
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
    const service = new GameService({ time: new FakeTime(), log: silentLog });
    const created = await service.create({
      white: 'a',
      black: 'b',
      initialFen: 'nonsense',
      clock: { initialSeconds: 600, incrementSeconds: 0 },
    });
    assert.equal(created.ok, false);
  });
});
