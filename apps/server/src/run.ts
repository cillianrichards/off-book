// Starts the live server in this process and stops it cleanly on SIGTERM or SIGINT (P2-08): games are
// saved, with lila's shutdown allowance, before the WebSockets close. It listens before it loads any game,
// and loads them only once it holds the live-games lock (P2-26), so a deploy hands games over safely.
//
// Environment:
//   DATABASE_URL   the PostgreSQL to save games in, at the latest migration (required)
//   PORT           the port to listen on (default 8080)
//   OFF_BOOK_CLIENT_DIR  the client's built bundle, served alongside the API (optional; deployments set it)

import pg from 'pg';

import { Bus } from './bus.ts';
import { type GameEvent, GameService, PostgresGameStore } from './game/index.ts';
import { PostgresLiveGamesLock } from './live-games-lock.ts';
import { errorFields, jsonLog as log } from './log.ts';
import { type Authenticate, startServer } from './server.ts';
import { realTime } from './time.ts';

export interface RunOptions {
  readonly authenticate: Authenticate;
  readonly saveDelayMs?: number;
}

function portFromEnvironment(): number {
  const text = process.env.PORT ?? '8080';
  const port = Number(text);
  if (!/^\d+$/.test(text) || port > 65_535) throw new Error(`PORT must be a port number, not "${text}".`);
  return port;
}

export async function run(options: RunOptions): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl === '')
    throw new Error('Set DATABASE_URL (see .env.example).');
  const port = portFromEnvironment();

  const pool = new pg.Pool({ connectionString: databaseUrl });
  // An idle connection that fails is replaced by the pool; without a listener the error would crash us.
  pool.on('error', error => log.warn('database connection lost', errorFields(error)));
  const games = new GameService({
    time: realTime,
    log,
    store: new PostgresGameStore(pool),
    // Nothing listens yet: rating (Phase 4) and fair play (Phase 5) will.
    bus: new Bus<GameEvent>(log),
    ...(options.saveDelayMs === undefined ? {} : { saveDelayMs: options.saveDelayMs }),
    waitForResume: true,
  });
  const clientDir = process.env.OFF_BOOK_CLIENT_DIR;
  const server = await startServer({
    port,
    games,
    authenticate: options.authenticate,
    log,
    ...(clientDir === undefined || clientDir === '' ? {} : { clientDir }),
  });
  log.info('listening', { port: server.port });

  // Hand-over (P2-26, D-23): listening already, so the host's health check passes and a deploy stops the
  // old process; this one loads the live games only once the old one has saved them and let go.
  const lock = new PostgresLiveGamesLock({ connectionString: databaseUrl, log });
  const waiting = new AbortController();
  let acquiring: Promise<boolean> = Promise.resolve(false);

  let stopping = false;
  const stop = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    log.info('stopping', { signal });
    waiting.abort();
    try {
      await acquiring.catch(() => false);
      await games.shutdown();
      // Saved: let the next process take the games before this one finishes closing.
      await lock.release();
      await server.close();
      await pool.end();
      log.info('stopped');
    } catch (error) {
      log.error('stop failed', errorFields(error));
      process.exitCode = 1;
    }
  };
  process.once('SIGTERM', () => void stop('SIGTERM'));
  process.once('SIGINT', () => void stop('SIGINT'));

  // Another process may hold the games once this one's lock is gone, so it must not save another move.
  void lock.lost.then(error => {
    log.error('lost the live games; stopping without saving', errorFields(error));
    process.exit(1);
  });

  acquiring = lock.acquire(waiting.signal);
  if ((await acquiring) && !stopping) await games.resume();
}
