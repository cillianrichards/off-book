import assert from 'node:assert/strict';
import { test } from 'node:test';

import { STANDARD_FEN } from '@off-book/rules';

import { gamePgn } from './pgn.ts';
import type { GameRecord } from './store.ts';

// After 1.d4 d5 2.c4 e6 3.Nc3 Nf6 4.Bg5 Nbd7 5.e3 c6 6.Nf3: Black to move, move 6.
const BLACK_TO_MOVE = 'r1bqkb1r/pp1n1ppp/2p1pn2/3p2B1/2PP4/2N1PN2/PP3PPP/R2QKB1R b KQkq - 1 6';
// After 1.e4 e5 2.Nf3 Nc6 3.Bc4: Black to move; and after 3...Bc5, White to move at move 4.
const WHITE_TO_MOVE = 'r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4';

function record(overrides: Partial<GameRecord>): GameRecord {
  return {
    id: 'abcd1234',
    players: { white: 'alice', black: 'bob' },
    initialFen: WHITE_TO_MOVE,
    clock: { initialSeconds: 600, incrementSeconds: 0 },
    status: 'started',
    moves: [],
    clockHistory: { white: [], black: [] },
    remaining: { white: 60_000, black: 60_000 },
    clockRunningSince: null,
    result: null,
    termination: null,
    createdAt: Date.UTC(2026, 10, 24, 9, 5, 7),
    lastMoveAt: null,
    finishedAt: null,
    ...overrides,
  };
}

const names = { white: 'alice', black: 'bob' };

test('writes the tags lila writes, with SetUp and FEN, for a game from a position', () => {
  const pgn = gamePgn(record({}), { names });
  assert.equal(
    pgn,
    [
      '[Event "Casual game"]',
      '[Site "?"]',
      '[Date "2026.11.24"]',
      '[White "alice"]',
      '[Black "bob"]',
      '[Result "*"]',
      '[UTCDate "2026.11.24"]',
      '[UTCTime "09:05:07"]',
      '[TimeControl "600+0"]',
      '[Termination "Unterminated"]',
      '[Variant "From Position"]',
      '[SetUp "1"]',
      `[FEN "${WHITE_TO_MOVE}"]`,
      '',
      '*',
      '',
    ].join('\n'),
  );
});

test('numbers moves from the FEN, with clock comments', () => {
  const pgn = gamePgn(
    record({
      moves: ['O-O', 'Nf6', 'd3'],
      clockHistory: { white: [60_000, 59_870], black: [59_455] },
    }),
    { names },
  );
  assert.match(
    pgn,
    /\n\n4\. O-O \{ \[%clk 0:10:00\] \} 4\.\.\. Nf6 \{ \[%clk 0:09:55\] \} 5\. d3 \{ \[%clk 0:09:59\] \} \*\n$/,
  );
});

test('opens with N... when Black moves first', () => {
  const pgn = gamePgn(
    record({
      initialFen: BLACK_TO_MOVE,
      moves: ['Qa5', 'Nd2', 'Bb4'],
      clockHistory: { white: [60_000], black: [60_000, 59_000] },
    }),
    { names },
  );
  assert.match(pgn, /\n\n6\.\.\. Qa5 \{[^}]*\} 7\. Nd2 \{[^}]*\} 7\.\.\. Bb4 \{[^}]*\} \*\n$/);
});

test('keeps SetUp and FEN, but not Variant, for the standard position', () => {
  const pgn = gamePgn(record({ initialFen: STANDARD_FEN, moves: ['e4'] }), { names });
  assert.ok(pgn.includes('[SetUp "1"]'));
  assert.ok(pgn.includes(`[FEN "${STANDARD_FEN}"]`));
  assert.ok(!pgn.includes('[Variant'));
  // A move without a recorded clock gets no comment.
  assert.match(pgn, /\n\n1\. e4 \*\n$/);
});

test('gives the result and lila’s Termination for each ending', () => {
  const cases: [Partial<GameRecord>, string, string][] = [
    [{ status: 'finished', result: '1-0', termination: 'checkmate' }, '1-0', 'Normal'],
    [{ status: 'finished', result: '1/2-1/2', termination: 'stalemate' }, '1/2-1/2', 'Normal'],
    [{ status: 'finished', result: '0-1', termination: 'flag' }, '0-1', 'Time forfeit'],
    [{ status: 'finished', result: '1/2-1/2', termination: 'flag' }, '1/2-1/2', 'Time forfeit'],
    [{ status: 'finished', result: '1-0', termination: 'abandonment' }, '1-0', 'Abandoned'],
    [{ status: 'aborted', termination: 'aborted' }, '*', 'Unterminated'],
  ];
  for (const [overrides, result, termination] of cases) {
    const pgn = gamePgn(record(overrides), { names });
    assert.ok(pgn.includes(`[Result "${result}"]`), result);
    assert.ok(pgn.includes(`[Termination "${termination}"]`), termination);
    assert.ok(pgn.endsWith(` ${result}\n`) || pgn.endsWith(`\n\n${result}\n`), result);
  }
});

test('writes hours in long clocks, and the site when given', () => {
  const pgn = gamePgn(
    record({
      clock: { initialSeconds: 10_800, incrementSeconds: 180 },
      moves: ['O-O'],
      clockHistory: { white: [1_080_000], black: [] },
    }),
    { names, site: 'https://example.org/abcd1234' },
  );
  assert.ok(pgn.includes('[TimeControl "10800+180"]'));
  assert.ok(pgn.includes('[Site "https://example.org/abcd1234"]'));
  assert.ok(pgn.includes('4. O-O { [%clk 3:00:00] }'));
});

test('escapes quotes and backslashes in tag values', () => {
  const pgn = gamePgn(record({}), { names: { white: 'a "quoted" name', black: 'back\\slash' } });
  assert.ok(pgn.includes('[White "a \\"quoted\\" name"]'));
  assert.ok(pgn.includes('[Black "back\\\\slash"]'));
});
