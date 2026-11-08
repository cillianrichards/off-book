// P2-04: games starting from a FEN, since pool positions come from games at any ply.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ChessGame, type MoveIntent } from './game.ts';

const start = (fen: string): ChessGame => {
  const result = ChessGame.fromFen(fen);
  assert.ok(result.ok, `expected ${fen} to start a game, got: ${result.ok ? '' : result.error}`);
  return result.game;
};

const move = (uci: string): MoveIntent => ({
  from: uci.slice(0, 2) as MoveIntent['from'],
  to: uci.slice(2, 4) as MoveIntent['to'],
});

// Plays each move, returning whether threefold repetition could be claimed after each one.
const claimsAfterEach = (game: ChessGame, ucis: readonly string[]): boolean[] =>
  ucis.map(uci => {
    assert.equal(game.play(move(uci)).ok, true, `${uci} should be legal`);
    return game.canClaimThreefold;
  });

const claimableAfter = (claims: readonly boolean[]): number => claims.indexOf(true) + 1;

describe('repetition counts from the given FEN', () => {
  test('the starting position is its first occurrence', () => {
    // Black to move, mid-opening; knights out and back twice returns to it twice more.
    const game = start('rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2');
    const claims = claimsAfterEach(game, ['b8c6', 'f3g1', 'c6b8', 'g1f3', 'b8c6', 'f3g1', 'c6b8', 'g1f3']);
    assert.equal(claimableAfter(claims), 8);
  });

  test('nothing before the FEN counts, even if the source game had repeated', () => {
    // The standard position as if reached again after 1.Nf3 Nf6 2.Ng1 Ng8: still only its first occurrence.
    const game = start('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 4 3');
    const claims = claimsAfterEach(game, ['g1f3', 'g8f6', 'f3g1', 'f6g8', 'g1f3', 'g8f6', 'f3g1', 'f6g8']);
    assert.equal(claimableAfter(claims), 8);
  });

  test('a position with different castling rights is a different position', () => {
    // Moving the h-rooks out and back costs both kingside rights, so the starting placement recurs
    // with different rights and does not repeat the start; the first claim comes from later positions.
    const game = start('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
    const shuffle = ['h1h2', 'h8h7', 'h2h1', 'h7h8'];
    const claims = claimsAfterEach(game, [...shuffle, ...shuffle, ...shuffle]);
    assert.equal(claims[7], false, 'the start, with all four rights, has occurred only once');
    assert.equal(claimableAfter(claims), 10);
  });

  test('an unusable en passant square in the FEN does not split the position in two', () => {
    const game = start('4k3/8/8/8/4P3/8/8/4K1N1 b - e3 0 1');
    const claims = claimsAfterEach(game, ['e8d7', 'g1f3', 'd7e8', 'f3g1', 'e8d7', 'g1f3', 'd7e8', 'f3g1']);
    assert.equal(claimableAfter(claims), 8);
  });
});

describe('castling rights come from the FEN', () => {
  const castlingSquares = (game: ChessGame, king: 'e1' | 'e8'): string[] => {
    const rank = king[1];
    return (game.legalMoves().get(king) ?? [])
      .filter(square => square === `g${rank}` || square === `c${rank}`)
      .toSorted();
  };

  test('a side castles only where the FEN gives it the right', () => {
    const game = start('r3k2r/8/8/8/8/8/8/R3K2R b k - 0 1');
    assert.deepEqual(castlingSquares(game, 'e8'), ['g8']);
    assert.equal(game.play(move('e8c8')).ok, false);
    assert.equal(game.play(move('a8b8')).ok, true);
    assert.deepEqual(castlingSquares(game, 'e1'), [], 'White has no rights in the FEN');
  });

  test('a right the pieces cannot use is dropped, so the castling move is illegal', () => {
    const game = start('r3k2r/8/8/8/8/8/8/R3K3 w KQkq - 0 1');
    assert.deepEqual(castlingSquares(game, 'e1'), ['c1']);
    assert.equal(game.play(move('e1g1')).ok, false);
  });
});

describe('en passant rights come from the FEN', () => {
  test('a capture the FEN allows can be the first move', () => {
    const game = start('4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1');
    assert.deepEqual(game.play(move('e5d6')), { ok: true, san: 'exd6' });
    assert.equal(game.fen, '4k3/8/3P4/8/8/8/8/4K3 b - - 0 1');
  });

  test('without the square in the FEN, the same capture is illegal', () => {
    const game = start('4k3/8/8/3pP3/8/8/8/4K3 w - - 0 1');
    assert.deepEqual(game.play(move('e5d6')), { ok: false, error: 'illegal' });
  });
});

describe('Black-to-move starts', () => {
  const afterE4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';

  test('Black moves first, and White cannot', () => {
    const game = start(afterE4);
    assert.equal(game.turn, 'black');
    assert.deepEqual(game.play(move('d2d4')), { ok: false, error: 'illegal' });
    assert.deepEqual(game.play(move('e7e5')), { ok: true, san: 'e5' });
    assert.equal(game.turn, 'white');
    assert.deepEqual(game.moves, ['e5']);
  });

  test('the move counters continue from the FEN', () => {
    const game = start('4k3/8/8/8/8/8/8/R3K3 b - - 97 40');
    assert.equal(game.play(move('e8d7')).ok, true);
    assert.equal(game.fen, '8/3k4/8/8/8/8/8/R3K3 w - - 98 41');
    assert.equal(game.play(move('a1a2')).ok, true);
    assert.equal(game.outcome, undefined);
    assert.equal(game.play(move('d7d6')).ok, true);
    assert.deepEqual(game.outcome, { termination: 'fiftyMoves' });
  });

  test('replays from its FEN', () => {
    const replayed = ChessGame.replay(afterE4, ['e5', 'Nf3', 'Nc6']);
    assert.equal(replayed.fen, 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3');
  });
});
