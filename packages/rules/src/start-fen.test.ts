import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { readStartFen, STANDARD_FEN } from './start-fen.ts';

const accepted = (input: string): string => {
  const result = readStartFen(input);
  assert.ok(result.ok, `expected ${input} to be accepted, got: ${result.ok ? '' : result.error}`);
  return result.fen;
};

const refused = (input: string): string => {
  const result = readStartFen(input);
  assert.ok(!result.ok, `expected ${input} to be refused`);
  return result.error;
};

describe('readStartFen accepts', () => {
  test('the standard position unchanged', () => {
    assert.equal(accepted(STANDARD_FEN), STANDARD_FEN);
  });

  test('a position from a real game unchanged', () => {
    const najdorf = 'rnbqkb1r/1p2pppp/p2p1n2/8/3NP3/2N5/PPP2PPP/R1BQKB1R w KQkq - 0 6';
    assert.equal(accepted(najdorf), najdorf);
  });

  test('a FEN without move counters, as starting a fresh count at move 1', () => {
    assert.equal(accepted('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -'), STANDARD_FEN);
  });

  test('surrounding and repeated whitespace', () => {
    assert.equal(accepted(`  ${STANDARD_FEN.replaceAll(' ', '   ')}\n`), STANDARD_FEN);
  });

  test('a full-move number of 0 as 1', () => {
    assert.equal(accepted('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 0'), STANDARD_FEN);
  });
});

describe('readStartFen refuses', () => {
  test('the wrong number of fields', () => {
    refused('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQ');
    refused(`${STANDARD_FEN} 7`);
    refused('');
  });

  test('move counters that are not whole numbers', () => {
    refused('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - x 1');
    refused('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 -1');
  });

  test('a side without exactly one king', () => {
    refused('8/8/8/8/8/8/8/4K3 w - - 0 1');
    refused('k7/8/8/8/8/8/8/KK6 w - - 0 1');
  });

  test('a pawn on the first or last rank', () => {
    refused('P3k3/8/8/8/8/8/8/4K3 w - - 0 1');
    refused('4k3/8/8/8/8/8/8/p3K3 w - - 0 1');
  });

  test('the side not to move in check', () => {
    refused('4k3/4Q3/8/8/8/8/8/4K3 w - - 0 1');
  });

  test('a game that is already over', () => {
    refused('7k/6Q1/6K1/8/8/8/8/8 b - - 0 1'); // checkmate
    refused('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1'); // stalemate
    refused('4k3/8/8/8/8/8/8/4KB2 w - - 0 1'); // insufficient material
    refused('4k3/8/8/8/8/8/8/R3K3 w - - 100 80'); // fifty-move rule
    refused('4k3/8/8/8/8/8/8/R3K3 w - - 150 80'); // capped at 100, as Lichess does
  });
});

describe('readStartFen cleans', () => {
  test('a castling right with no rook in the corner', () => {
    assert.equal(accepted('r3k2r/8/8/8/8/8/8/R3K3 w KQkq - 0 1'), 'r3k2r/8/8/8/8/8/8/R3K3 w Qkq - 0 1');
  });

  test('castling rights for a king off its home square', () => {
    assert.equal(accepted('r3k2r/8/8/8/8/8/8/R4K1R w KQkq - 0 1'), 'r3k2r/8/8/8/8/8/8/R4K1R w kq - 0 1');
  });

  test('a castling right whose corner holds the other side’s rook', () => {
    assert.equal(accepted('r3k2r/8/8/8/8/8/8/R3K2r w KQkq - 0 1'), 'r3k2r/8/8/8/8/8/8/R3K2r w Qkq - 0 1');
  });

  test('an en passant square no pawn can capture on', () => {
    assert.equal(accepted('4k3/8/8/8/4P3/8/8/4K3 b - e3 0 1'), '4k3/8/8/8/4P3/8/8/4K3 b - - 0 1');
  });

  test('an en passant square whose only capturer is pinned', () => {
    assert.equal(accepted('8/8/8/8/k2pP2R/8/8/4K3 b - e3 0 1'), '8/8/8/8/k2pP2R/8/8/4K3 b - - 0 1');
  });

  test('but keeps an en passant square where a capture is legal', () => {
    assert.equal(accepted('4k3/8/8/8/3pP3/8/8/4K3 b - e3 0 1'), '4k3/8/8/8/3pP3/8/8/4K3 b - e3 0 1');
  });
});
