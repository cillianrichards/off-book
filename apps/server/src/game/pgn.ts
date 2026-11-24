// PGN built from a game's row when asked for (P2-18), as lila's export builds it; no PGN is stored
// (D-02). Every game starts from a FEN, so every export carries `SetUp` and `FEN` tags, which is what
// lets Lichess's analysis board and desktop tools open it at the right position.
//
// Tags and their values follow lila's PgnDump: the Seven Tag Roster without `Round`, then `UTCDate`,
// `UTCTime`, `TimeControl`, `Termination`, and `Variant "From Position"` for a non-standard start.
// Each move carries its mover's clock as a `[%clk H:MM:SS]` comment, as lila's export does.

import { type Colour, STANDARD_FEN } from '@off-book/rules';

import type { GameTermination } from './live-game.ts';
import type { GameRecord } from './store.ts';

export interface PgnOptions {
  /** How each player is named in the `White` and `Black` tags. */
  readonly names: Readonly<Record<Colour, string>>;
  /** The game's public address, for the `Site` tag; `?`, PGN's "unknown", without one. */
  readonly site?: string;
}

export function gamePgn(record: GameRecord, options: PgnOptions): string {
  const created = new Date(record.createdAt);
  const result = resultTag(record);
  const tags: [string, string][] = [
    ['Event', 'Casual game'],
    ['Site', options.site ?? '?'],
    ['Date', pgnDate(created)],
    ['White', options.names.white],
    ['Black', options.names.black],
    ['Result', result],
    ['UTCDate', pgnDate(created)],
    ['UTCTime', created.toISOString().slice(11, 19)],
    ['TimeControl', `${record.clock.initialSeconds}+${record.clock.incrementSeconds}`],
    ['Termination', terminationTag(record.status, record.termination)],
  ];
  if (record.initialFen !== STANDARD_FEN) tags.push(['Variant', 'From Position']);
  tags.push(['SetUp', '1'], ['FEN', record.initialFen]);

  const header = tags.map(([name, value]) => `[${name} "${escape(value)}"]`).join('\n');
  return `${header}\n\n${movetext(record, result)}\n`;
}

function movetext(record: GameRecord, result: string): string {
  // Numbering continues from the FEN's move number, and a game that starts with Black to move opens
  // with `N...`, as lila and the PGN standard both write it.
  const [, side, , , , fullmove] = record.initialFen.split(' ');
  const firstMover: Colour = side === 'b' ? 'black' : 'white';
  let number = Number(fullmove);
  if (!Number.isInteger(number) || number < 1) number = 1;

  const tokens: string[] = [];
  const clockIndex: Record<Colour, number> = { white: 0, black: 0 };
  record.moves.forEach((san, index) => {
    const mover: Colour = (index % 2 === 0) === (firstMover === 'white') ? 'white' : 'black';
    // Black's move repeats its number after anything that interrupts the move pair: the start of the
    // game, or a clock comment.
    if (mover === 'white') tokens.push(`${number}.`);
    else if (index === 0 || tokens.at(-1)?.endsWith('}') === true) tokens.push(`${number}...`);
    tokens.push(san);
    const centis = record.clockHistory[mover][clockIndex[mover]];
    clockIndex[mover] += 1;
    if (centis !== undefined) tokens.push(`{ [%clk ${clockComment(centis)}] }`);
    if (mover === 'black') number += 1;
  });
  tokens.push(result);
  return tokens.join(' ');
}

function resultTag(record: GameRecord): string {
  return record.status === 'finished' && record.result !== null ? record.result : '*';
}

// lila's mapping from a game's status to the PGN `Termination` tag.
const TERMINATION_TAGS: Readonly<Record<GameTermination, string>> = {
  checkmate: 'Normal',
  stalemate: 'Normal',
  insufficientMaterial: 'Normal',
  fiftyMoves: 'Normal',
  fivefoldRepetition: 'Normal',
  flag: 'Time forfeit',
  abandonment: 'Abandoned',
  aborted: 'Unterminated',
};

function terminationTag(status: GameRecord['status'], termination: GameTermination | null): string {
  return status === 'finished' && termination !== null ? TERMINATION_TAGS[termination] : 'Unterminated';
}

// H:MM:SS, rounded to the second, as lila writes `%clk`.
function clockComment(centis: number): string {
  const total = Math.max(0, Math.round(centis / 100));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return `${hours}:${pad(minutes)}:${pad(seconds)}`;
}

function pgnDate(date: Date): string {
  return `${date.getUTCFullYear()}.${pad(date.getUTCMonth() + 1)}.${pad(date.getUTCDate())}`;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

// A tag value is a PGN string token: backslash and double quote are escaped with a backslash.
function escape(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}
