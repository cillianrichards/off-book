// Runs against a real PostgreSQL at the latest migration, named by OFF_BOOK_TEST_DATABASE_URL: CI's stack job
// sets it (`pnpm --filter @off-book/server test:postgres`); without it these tests are skipped. They touch
// only the rows they create, and delete them afterwards.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import pg from 'pg';

import { sampleRecord, storeContract } from '../testing/store-contract.ts';
import { PostgresGameStore } from './postgres-store.ts';

const url = process.env.OFF_BOOK_TEST_DATABASE_URL;
const skip = url === undefined ? 'set OFF_BOOK_TEST_DATABASE_URL to run the PostgreSQL tests' : false;

describe('PostgresGameStore', { skip }, () => {
  let pool: pg.Pool;
  let store: PostgresGameStore;
  const made = new Set<string>();

  before(() => {
    pool = new pg.Pool({ connectionString: url });
    store = new PostgresGameStore(pool);
  });

  after(async () => {
    await pool.query('delete from game where id = any($1)', [[...made]]);
    await pool.end();
  });

  describe('keeps the store contract', () => {
    storeContract(() => store, made);
  });

  describe('the game table refuses a row that contradicts itself', () => {
    const refused = async (overrides: Parameters<typeof sampleRecord>[0]) => {
      const record = sampleRecord(overrides);
      made.add(record.id);
      await assert.rejects(store.insert(record), /violates check constraint/);
    };

    test('a finished game without a result, or a started one with one', async () => {
      await refused({ status: 'finished', termination: 'flag', finishedAt: 1, clockRunningSince: null });
      await refused({ result: '1-0' });
    });

    test('a running clock on a game that is over', async () => {
      await refused({ status: 'finished', result: '1-0', termination: 'flag', finishedAt: 1 });
    });

    test('an aborted game with another termination', async () => {
      await refused({ status: 'aborted', termination: 'flag', finishedAt: 1, clockRunningSince: null });
    });

    test('a clock history that does not match the moves', async () => {
      await refused({ moves: ['e4'] });
    });

    test('one player on both sides', async () => {
      await refused({ players: { white: 'alice', black: 'alice' } });
    });
  });
});
