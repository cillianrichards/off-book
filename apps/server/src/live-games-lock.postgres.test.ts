// The live-games lock (P2-26) against a real PostgreSQL. Needs OFF_BOOK_TEST_DATABASE_URL, like the store's
// tests; skipped without it. Each test takes its own key, so none waits on another or on a running server.

import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { after, describe, test } from 'node:test';

import pg from 'pg';

import { PostgresLiveGamesLock } from './live-games-lock.ts';
import { silentLog } from './log.ts';

const url = process.env.OFF_BOOK_TEST_DATABASE_URL;
const skip = url === undefined ? 'set OFF_BOOK_TEST_DATABASE_URL to run the PostgreSQL tests' : false;

describe('the live-games lock (P2-26)', { skip }, () => {
  const pool = new pg.Pool({ connectionString: url });
  const locks: PostgresLiveGamesLock[] = [];

  after(async () => {
    for (const lock of locks) await lock.release().catch(() => {});
    await pool.end();
  });

  const newKey = () => String(randomInt(1, 2 ** 47));
  const newLock = (key: string, heartbeatMs = 5000) => {
    const lock = new PostgresLiveGamesLock({
      connectionString: url ?? '',
      log: silentLog,
      key,
      pollMs: 50,
      heartbeatMs,
    });
    locks.push(lock);
    return lock;
  };

  /** Whether a promise has settled within a short wait. */
  const settledWithin = async (promise: Promise<unknown>, ms: number) => {
    let settled = false;
    void promise.then(
      () => (settled = true),
      () => (settled = true),
    );
    await new Promise(resolve => setTimeout(resolve, ms));
    return settled;
  };

  test('a second process waits until the first releases the lock', async () => {
    const key = newKey();
    const first = newLock(key);
    const second = newLock(key);
    assert.equal(await first.acquire(new AbortController().signal), true);
    const waiting = second.acquire(new AbortController().signal);
    assert.equal(
      await settledWithin(waiting, 300),
      false,
      'the second does not get the lock while it is held',
    );
    await first.release();
    assert.equal(await waiting, true);
    await second.release();
  });

  test('a process that dies outright frees the lock at once', async () => {
    const key = newKey();
    const first = newLock(key);
    assert.equal(await first.acquire(new AbortController().signal), true);
    // As SIGKILL would: the holder's connection disappears without unlocking.
    await pool.query(
      `select pg_terminate_backend(pid) from pg_locks
       where locktype = 'advisory' and granted and (classid::bigint << 32 | objid::bigint) = $1::bigint`,
      [key],
    );
    assert.ok((await first.lost) instanceof Error, 'the holder learns it has lost the lock');
    const second = newLock(key);
    assert.equal(await second.acquire(new AbortController().signal), true);
    await second.release();
  });

  test('a lost connection is noticed by the heartbeat', async () => {
    const key = newKey();
    const lock = newLock(key, 100);
    assert.equal(await lock.acquire(new AbortController().signal), true);
    await pool.query(
      `select pg_terminate_backend(pid) from pg_locks
       where locktype = 'advisory' and granted and (classid::bigint << 32 | objid::bigint) = $1::bigint`,
      [key],
    );
    const lost = await Promise.race([
      lock.lost,
      new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), 2000)),
    ]);
    assert.ok(lost instanceof Error);
  });

  test('stopping while waiting gives up without the lock', async () => {
    const key = newKey();
    const holder = newLock(key);
    assert.equal(await holder.acquire(new AbortController().signal), true);
    const waiter = newLock(key);
    const stop = new AbortController();
    const waiting = waiter.acquire(stop.signal);
    await new Promise(resolve => setTimeout(resolve, 100));
    stop.abort();
    assert.equal(await waiting, false);
    await holder.release();
  });

  test('releasing a lock never taken does nothing', async () => {
    await newLock(newKey()).release();
  });
});
