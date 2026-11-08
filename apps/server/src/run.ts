// Starts the live server in this process and stops it cleanly on SIGTERM or SIGINT (P2-08): games are
// saved, with lila's shutdown allowance, before the WebSockets close.
//
// Environment:
//   DATABASE_URL   the PostgreSQL to save games in, at the latest migration (required)
//   PORT           the port to listen on (default 8080)

import pg from 'pg';

import { Bus } from './bus.ts';
import { type GameEvent, GameService, PostgresGameStore } from './game/index.ts';
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
  });
  await games.resume();
  const server = await startServer({ port, games, authenticate: options.authenticate, log });
  log.info('listening', { port: server.port });

  let stopping = false;
  const stop = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    log.info('stopping', { signal });
    try {
      await games.shutdown();
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
}
