// What every game store must do, run against the in-memory store always and against PostgreSQL when a
// test database is given, so the two cannot drift apart.

import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { test } from 'node:test';

import { STANDARD_FEN } from '@off-book/rules';

import type { GameRecord, GameStore } from '../game/index.ts';

let serial = 0;
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const randomId = () => Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');

/** A record for a game in progress, with a fresh id, a running clock and moves that need quoting in SQL. */
export function sampleRecord(overrides: Partial<GameRecord> = {}): GameRecord {
  serial += 1;
  const id = randomId();
  return {
    id,
    players: { white: `white-${id}`, black: `black-${id}` },
    initialFen: STANDARD_FEN,
    clock: { initialSeconds: 600, incrementSeconds: 0 },
    status: 'started',
    // Check, capture and promotion signs, which an array literal must keep intact.
    moves: ['e4', 'd5', 'exd5', 'Qxd5', 'Nc3', 'Qa5', 'Bc4', 'Nf6', 'Bxf7+', 'Kxf7'],
    clockHistory: {
      white: [60_000, 60_000, 59_100, 58_000, 57_500],
      black: [60_000, 59_800, 59_000, 58_400, 57_900],
    },
    remaining: { white: 57_500, black: 57_900 },
    clockRunningSince: Date.UTC(2026, 10, 8, 12, 0, 30),
    result: null,
    termination: null,
    createdAt: Date.UTC(2026, 10, 8, 12) + serial,
    lastMoveAt: Date.UTC(2026, 10, 8, 12, 0, 30),
    finishedAt: null,
    ...overrides,
  };
}

/** Runs the contract. `made` records every id a test saves, so the caller can clean up. */
export function storeContract(store: () => GameStore, made: Set<string>): void {
  const saved = async (record: GameRecord): Promise<GameRecord> => {
    made.add(record.id);
    assert.equal(await store().insert(record), 'inserted');
    return record;
  };

  test('saves a new game and loads it back exactly', async () => {
    const record = await saved(sampleRecord());
    assert.deepEqual(await store().load(record.id), record);
  });

  test('says when an id is taken, keeping the game already saved', async () => {
    const record = await saved(sampleRecord());
    assert.equal(await store().insert({ ...record, players: { white: 'x', black: 'y' } }), 'duplicateId');
    assert.deepEqual((await store().load(record.id))?.players, record.players);
  });

  test('saves a game’s latest state over its last', async () => {
    const record = await saved(sampleRecord());
    const finished: GameRecord = {
      ...record,
      status: 'finished',
      moves: [...record.moves, 'Qh5+'],
      clockHistory: { white: [...record.clockHistory.white, 55_000], black: record.clockHistory.black },
      remaining: { white: 55_000, black: 57_900 },
      clockRunningSince: null,
      result: '1-0',
      termination: 'flag',
      lastMoveAt: record.createdAt + 60_000,
      finishedAt: record.createdAt + 90_000,
    };
    await store().update(finished);
    assert.deepEqual(await store().load(record.id), finished);
  });

  test('refuses to update a game never saved', async () => {
    await assert.rejects(store().update(sampleRecord()), /has not been saved before/);
  });

  test('loads only the games still being played, oldest first', async () => {
    const older = await saved(sampleRecord());
    const aborted = await saved(
      sampleRecord({ moves: [], clockHistory: { white: [], black: [] }, clockRunningSince: null }),
    );
    const newer = await saved(sampleRecord());
    await store().update({
      ...aborted,
      status: 'aborted',
      termination: 'aborted',
      finishedAt: aborted.createdAt + 1,
    });
    const started = (await store().loadStarted())
      .filter(record => made.has(record.id))
      .map(record => record.id);
    assert.ok(started.indexOf(older.id) < started.indexOf(newer.id));
    assert.ok(started.includes(older.id) && started.includes(newer.id));
    assert.ok(!started.includes(aborted.id));
  });

  test('finds nothing for an unknown id', async () => {
    assert.equal(await store().load('Zz000000'), undefined);
  });
}
