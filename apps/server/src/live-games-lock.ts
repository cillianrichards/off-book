// One server process per database holds the live games (P2-26). Live games are kept in memory (D-01), so a
// second process loading them, as Container Apps starts while a deploy swaps revisions, would play from a
// stale copy and overwrite the first process's saves. A PostgreSQL advisory lock decides which process may
// load, play and save them.
//
// Hand-over (D-23): a new process waits for the lock while the old one saves every game and releases it,
// then loads the games. The lock lives on a connection of its own, so it is held exactly as long as that
// connection: PostgreSQL drops it the moment a process dies. A process that loses its connection while
// holding the lock must stop playing at once, without saving, because another may already hold it.

import pg from 'pg';

import type { Log } from './log.ts';

/** "OffBook" as a 64-bit number: the key every Off Book process locks. */
export const LIVE_GAMES_LOCK_KEY = '22349112547438443';

export interface LiveGamesLock {
  /** Waits until this process holds the lock: true once it does, false if `signal` aborts first. */
  acquire(signal: AbortSignal): Promise<boolean>;
  /** Resolves, with why, if the lock is lost while held. */
  readonly lost: Promise<Error>;
  /** Gives the lock up, if held, so the next process can take it. */
  release(): Promise<void>;
}

export interface PostgresLockOptions {
  readonly connectionString: string;
  readonly log: Log;
  /** How often to try for the lock while another process holds it. */
  readonly pollMs?: number;
  /** How often to check the connection while holding the lock. */
  readonly heartbeatMs?: number;
  /** The lock to take; every process shares the default. Tests use their own, so as not to wait on servers. */
  readonly key?: string;
}

export class PostgresLiveGamesLock implements LiveGamesLock {
  readonly lost: Promise<Error>;
  readonly #options: PostgresLockOptions;
  readonly #key: string;
  #lose: (error: Error) => void = () => {};
  #client: pg.Client | undefined;
  #heartbeat: NodeJS.Timeout | undefined;
  #held = false;
  #releasing = false;

  constructor(options: PostgresLockOptions) {
    this.#options = options;
    this.#key = options.key ?? LIVE_GAMES_LOCK_KEY;
    this.lost = new Promise(resolve => {
      this.#lose = resolve;
    });
  }

  async acquire(signal: AbortSignal): Promise<boolean> {
    const heartbeatMs = this.#options.heartbeatMs ?? 5000;
    const client = new pg.Client({
      connectionString: this.#options.connectionString,
      keepAlive: true,
      // A query on a dead connection fails within a heartbeat rather than hanging.
      query_timeout: heartbeatMs,
    });
    this.#client = client;
    client.on('error', error => this.#fail(error));
    client.on('end', () => this.#fail(new Error('the lock’s database connection ended')));
    await client.connect();

    let told = false;
    while (!signal.aborted) {
      const { rows } = await client.query<{ held: boolean }>('select pg_try_advisory_lock($1) as held', [
        this.#key,
      ]);
      if (rows[0]?.held === true) {
        this.#held = true;
        this.#heartbeat = setInterval(() => {
          client.query('select 1').catch((error: unknown) => {
            this.#fail(error instanceof Error ? error : new Error(String(error)));
          });
        }, heartbeatMs);
        this.#heartbeat.unref();
        this.#options.log.info('holding the live games');
        return true;
      }
      if (!told) {
        this.#options.log.info('waiting for another server to save and release the live games');
        told = true;
      }
      await pause(this.#options.pollMs ?? 1000, signal);
    }
    this.#releasing = true;
    await client.end();
    return false;
  }

  async release(): Promise<void> {
    const client = this.#client;
    if (client === undefined || this.#releasing) return;
    this.#releasing = true;
    clearInterval(this.#heartbeat);
    if (this.#held) await client.query('select pg_advisory_unlock($1)', [this.#key]);
    this.#held = false;
    await client.end();
    this.#options.log.info('released the live games');
  }

  #fail(error: Error): void {
    if (!this.#held || this.#releasing) return;
    this.#held = false;
    clearInterval(this.#heartbeat);
    this.#lose(error);
  }
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
  });
}
