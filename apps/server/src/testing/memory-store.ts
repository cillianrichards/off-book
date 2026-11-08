// A game store in memory, for tests. The same contract tests run against it and against PostgreSQL, so it
// behaves like the real one. It can also be told to fail, as a database that has gone away would.

import type { GameRecord, GameStore } from '../game/index.ts';

const copy = (record: GameRecord): GameRecord => structuredClone(record);

export class MemoryGameStore implements GameStore {
  readonly #rows = new Map<string, GameRecord>();
  /** While true, every call fails. */
  failing = false;
  /** How many times `update` has saved a game. */
  updates = 0;

  async insert(record: GameRecord): Promise<'inserted' | 'duplicateId'> {
    this.#check();
    if (this.#rows.has(record.id)) return 'duplicateId';
    this.#rows.set(record.id, copy(record));
    return 'inserted';
  }

  async update(record: GameRecord): Promise<void> {
    this.#check();
    if (!this.#rows.has(record.id)) throw new Error(`Game ${record.id} has not been saved before`);
    this.#rows.set(record.id, copy(record));
    this.updates += 1;
  }

  async load(id: string): Promise<GameRecord | undefined> {
    this.#check();
    const record = this.#rows.get(id);
    return record === undefined ? undefined : copy(record);
  }

  async loadStarted(): Promise<GameRecord[]> {
    this.#check();
    return [...this.#rows.values()]
      .filter(record => record.status === 'started')
      .toSorted((a, b) => a.createdAt - b.createdAt)
      .map(copy);
  }

  /** The saved record, without going through the async interface. */
  saved(id: string): GameRecord | undefined {
    return this.#rows.get(id);
  }

  #check(): void {
    if (this.failing) throw new Error('The store is unavailable');
  }
}
