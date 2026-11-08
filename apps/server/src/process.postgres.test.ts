// P2-08's exit test, on real processes: the server is started as a child process against PostgreSQL, games
// are played over its WebSockets, and the process is then killed outright or stopped cleanly before the
// next one starts. Needs OFF_BOOK_TEST_DATABASE_URL, like the store's tests; skipped without it.

import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { after, describe, test } from 'node:test';

import { STANDARD_FEN } from '@off-book/rules';
import pg from 'pg';

import { type GameRecord, PostgresGameStore } from './game/index.ts';
import { openClient, type TestClient } from './testing/client.ts';
import { TEST_USER_HEADER } from './testing/test-auth.ts';

const url = process.env.OFF_BOOK_TEST_DATABASE_URL;
const skip = url === undefined ? 'set OFF_BOOK_TEST_DATABASE_URL to run the PostgreSQL tests' : false;
const TEST_SERVER = fileURLToPath(new URL('./testing/test-server.ts', import.meta.url));

interface Server {
  readonly port: number;
  readonly exited: Promise<number | null>;
  kill(signal: NodeJS.Signals): Promise<number | null>;
}

const running = new Set<ChildProcess>();

/** Starts the server in a child process and waits until it is listening. */
function startServer(saveDelayMs: number): Promise<Server> {
  const child = spawn(process.execPath, [TEST_SERVER], {
    env: { ...process.env, DATABASE_URL: url, PORT: '0', OFF_BOOK_SAVE_DELAY_MS: String(saveDelayMs) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  running.add(child);
  const exited = new Promise<number | null>(resolve =>
    child.once('exit', code => {
      running.delete(child);
      resolve(code);
    }),
  );
  let errors = '';
  child.stderr.on('data', (chunk: Buffer) => {
    errors += chunk.toString();
  });
  return new Promise((resolve, reject) => {
    let buffered = '';
    child.stdout.on('data', (chunk: Buffer) => {
      buffered += chunk.toString();
      for (const line of buffered.split('\n').slice(0, -1)) {
        const entry = JSON.parse(line) as { message?: string; port?: number };
        if (entry.message === 'listening' && entry.port !== undefined) {
          resolve({
            port: entry.port,
            exited,
            kill: signal => {
              child.kill(signal);
              return exited;
            },
          });
        }
      }
      buffered = buffered.slice(buffered.lastIndexOf('\n') + 1);
    });
    void exited.then(code => reject(new Error(`The server exited with ${code} before listening: ${errors}`)));
  });
}

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const randomId = () => Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');

describe('the server process (P2-08)', { skip }, () => {
  const pool = new pg.Pool({ connectionString: url });
  const store = new PostgresGameStore(pool);
  const made: string[] = [];

  after(async () => {
    for (const child of running) child.kill('SIGKILL');
    await pool.query('delete from game where id = any($1)', [made]);
    await pool.end();
  });

  /** A new 10+0 game from the standard position, saved as the service would save it. */
  async function newGame(): Promise<GameRecord> {
    const id = randomId();
    const record: GameRecord = {
      id,
      players: { white: `w-${id}`, black: `b-${id}` },
      initialFen: STANDARD_FEN,
      clock: { initialSeconds: 600, incrementSeconds: 0 },
      status: 'started',
      moves: [],
      clockHistory: { white: [], black: [] },
      remaining: { white: 60_000, black: 60_000 },
      clockRunningSince: null,
      result: null,
      termination: null,
      createdAt: Date.now(),
      lastMoveAt: null,
      finishedAt: null,
    };
    made.push(id);
    assert.equal(await store.insert(record), 'inserted');
    return record;
  }

  async function seat(server: Server, game: GameRecord) {
    const connect = async (user: string): Promise<TestClient> => {
      const opened = await openClient(`ws://127.0.0.1:${server.port}/play/${game.id}`, {
        [TEST_USER_HEADER]: user,
      });
      assert.ok(opened.ok, `${user} should connect`);
      return opened.client;
    };
    const white = await connect(game.players.white);
    const black = await connect(game.players.black);
    const state = await white.nextOf('state');
    await black.nextOf('state');
    return { white, black, state };
  }

  /** Plays moves alternately from the given ply, waiting for each to come back to both players. */
  async function play(
    players: { white: TestClient; black: TestClient },
    from: number,
    ucis: readonly string[],
  ) {
    let last;
    for (const [index, uci] of ucis.entries()) {
      const ply = from + index;
      (ply % 2 === 0 ? players.white : players.black).send({ t: 'move', ply, uci });
      last = await players.white.nextOf('move');
      await players.black.nextOf('move');
    }
    return last;
  }

  test('killing the process mid-game resumes the game from its last save', async () => {
    const game = await newGame();
    const first = await startServer(60_000);
    await play(await seat(first, game), 0, ['e2e4', 'e7e5', 'g1f3', 'b8c6']);
    // Each side's first move was saved at once; the next two were still waiting when the process died.
    await first.kill('SIGKILL');
    assert.deepEqual((await store.load(game.id))?.moves, ['e4', 'e5']);

    const second = await startServer(300);
    const resumed = await seat(second, game);
    assert.deepEqual(resumed.state.game.moves, ['e4', 'e5']);
    assert.equal(resumed.state.game.clock.running, true);
    await play(resumed, 2, ['d2d4']);
    await new Promise(resolve => setTimeout(resolve, 600));
    await second.kill('SIGKILL');
    assert.deepEqual(
      (await store.load(game.id))?.moves,
      ['e4', 'e5', 'd4'],
      'a waiting move is saved after the delay',
    );

    const third = await startServer(60_000);
    assert.deepEqual((await seat(third, game)).state.game.moves, ['e4', 'e5', 'd4']);
    assert.equal(await third.kill('SIGTERM'), 0);
  });

  test('a clean restart resumes every game with lila’s allowance', async () => {
    const games = [await newGame(), await newGame()];
    const first = await startServer(60_000);
    const clocks = [];
    for (const game of games) {
      const last = await play(await seat(first, game), 0, ['e2e4', 'c7c5', 'g1f3', 'd7d6']);
      assert.ok(last);
      clocks.push(last.clock);
    }
    assert.equal(await first.kill('SIGTERM'), 0, 'a clean stop exits normally');

    const second = await startServer(60_000);
    for (const [index, game] of games.entries()) {
      const saved = await store.load(game.id);
      assert.deepEqual(saved?.moves, ['e4', 'c5', 'Nf3', 'd6'], 'every move is saved on a clean stop');
      // White, to move, gets 20 seconds; Black gets 10.
      assert.deepEqual(saved?.remaining, {
        white: (clocks[index]?.white ?? 0) + 2000,
        black: (clocks[index]?.black ?? 0) + 1000,
      });
      const resumed = await seat(second, game);
      assert.equal(resumed.state.game.ply, 4);
      assert.ok(
        resumed.state.game.clock.white > (clocks[index]?.white ?? 0),
        'the allowance outweighs the restart',
      );
      await play(resumed, 4, ['d2d4']);
    }
    assert.equal(await second.kill('SIGTERM'), 0);
  });
});
