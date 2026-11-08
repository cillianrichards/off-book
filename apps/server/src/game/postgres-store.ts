// Games saved in PostgreSQL's `game` table (P2-12). The schema belongs to the migrations, not to this file.

import type { Pool } from 'pg';

import type { GameStatus, GameTermination, Result } from './live-game.ts';
import type { GameRecord, GameStore } from './store.ts';

interface GameRow {
  id: string;
  white_id: string;
  black_id: string;
  initial_fen: string;
  clock_initial_seconds: number;
  clock_increment_seconds: number;
  status: GameStatus;
  moves: string[];
  white_clock_history: number[];
  black_clock_history: number[];
  white_remaining_cs: number;
  black_remaining_cs: number;
  clock_running_since: Date | null;
  result: Result | null;
  termination: GameTermination | null;
  created_at: Date;
  last_move_at: Date | null;
  finished_at: Date | null;
}

const UNIQUE_VIOLATION = '23505';

const instant = (ms: number | null): Date | null => (ms === null ? null : new Date(ms));
const millis = (date: Date | null): number | null => (date === null ? null : date.getTime());

export class PostgresGameStore implements GameStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async insert(record: GameRecord): Promise<'inserted' | 'duplicateId'> {
    try {
      await this.#pool.query(
        `insert into game (
           id, white_id, black_id, initial_fen, clock_initial_seconds, clock_increment_seconds, status,
           moves, white_clock_history, black_clock_history, white_remaining_cs, black_remaining_cs,
           clock_running_since, result, termination, created_at, last_move_at, finished_at
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
        [
          record.id,
          record.players.white,
          record.players.black,
          record.initialFen,
          record.clock.initialSeconds,
          record.clock.incrementSeconds,
          ...this.#state(record),
          new Date(record.createdAt),
          instant(record.lastMoveAt),
          instant(record.finishedAt),
        ],
      );
      return 'inserted';
    } catch (error) {
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) return 'duplicateId';
      throw error;
    }
  }

  async update(record: GameRecord): Promise<void> {
    const updated = await this.#pool.query(
      `update game set
         status = $2, moves = $3, white_clock_history = $4, black_clock_history = $5,
         white_remaining_cs = $6, black_remaining_cs = $7, clock_running_since = $8,
         result = $9, termination = $10, last_move_at = $11, finished_at = $12
       where id = $1`,
      [record.id, ...this.#state(record), instant(record.lastMoveAt), instant(record.finishedAt)],
    );
    if (updated.rowCount !== 1) throw new Error(`Game ${record.id} has not been saved before`);
  }

  async load(id: string): Promise<GameRecord | undefined> {
    const { rows } = await this.#pool.query<GameRow>('select * from game where id = $1', [id]);
    const [row] = rows;
    return row === undefined ? undefined : recordOf(row);
  }

  async loadStarted(): Promise<GameRecord[]> {
    const { rows } = await this.#pool.query<GameRow>(
      `select * from game where status = 'started' order by created_at`,
    );
    return rows.map(recordOf);
  }

  // The columns a game changes as it is played, in the order both statements use.
  #state(record: GameRecord): unknown[] {
    return [
      record.status,
      record.moves,
      record.clockHistory.white,
      record.clockHistory.black,
      record.remaining.white,
      record.remaining.black,
      instant(record.clockRunningSince),
      record.result,
      record.termination,
    ];
  }
}

function recordOf(row: GameRow): GameRecord {
  return {
    id: row.id,
    players: { white: row.white_id, black: row.black_id },
    initialFen: row.initial_fen,
    clock: { initialSeconds: row.clock_initial_seconds, incrementSeconds: row.clock_increment_seconds },
    status: row.status,
    moves: row.moves,
    clockHistory: { white: row.white_clock_history, black: row.black_clock_history },
    remaining: { white: row.white_remaining_cs, black: row.black_remaining_cs },
    clockRunningSince: millis(row.clock_running_since),
    result: row.result,
    termination: row.termination,
    createdAt: row.created_at.getTime(),
    lastMoveAt: millis(row.last_move_at),
    finishedAt: millis(row.finished_at),
  };
}
