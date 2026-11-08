import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ChessGame, type MoveIntent } from './game.ts';
import { STANDARD_FEN } from './start-fen.ts';

const start = (fen: string): ChessGame => {
  const result = ChessGame.fromFen(fen);
  assert.ok(result.ok, `expected ${fen} to start a game, got: ${result.ok ? '' : result.error}`);
  return result.game;
};

const move = (uci: string): MoveIntent => {
  const promotion = uci[4];
  return {
    from: uci.slice(0, 2) as MoveIntent['from'],
    to: uci.slice(2, 4) as MoveIntent['to'],
    ...(promotion === undefined ? {} : { promotion: promotion as NonNullable<MoveIntent['promotion']> }),
  };
};

const playAll = (game: ChessGame, ucis: readonly string[]): void => {
  for (const uci of ucis) assert.equal(game.play(move(uci)).ok, true, `${uci} should be legal`);
};

// Knights out and back: each four plies return the board to where it started.
const KNIGHT_SHUFFLE = ['g1f3', 'g8f6', 'f3g1', 'f6g8'];

describe('ChessGame.fromFen', () => {
  test('starts from the standard position', () => {
    const game = start(STANDARD_FEN);
    assert.equal(game.fen, STANDARD_FEN);
    assert.equal(game.turn, 'white');
    assert.deepEqual(game.moves, []);
    assert.equal(game.outcome, undefined);
  });

  test('refuses a FEN readStartFen refuses', () => {
    const result = ChessGame.fromFen('8/8/8/8/8/8/8/4K3 w - - 0 1');
    assert.equal(result.ok, false);
  });
});

describe('legalMoves', () => {
  test('lists every destination from each origin square', () => {
    const destinations = start(STANDARD_FEN).legalMoves();
    assert.equal(destinations.size, 10);
    assert.equal([...destinations.values()].flat().length, 20);
    assert.deepEqual(destinations.get('g1')?.toSorted(), ['f3', 'h3']);
    assert.deepEqual(destinations.get('e2')?.toSorted(), ['e3', 'e4']);
  });

  test('counts a promotion once, whichever piece is chosen', () => {
    const destinations = start('8/4P3/8/8/8/k7/8/4K3 w - - 0 1').legalMoves();
    assert.deepEqual(destinations.get('e7'), ['e8']);
  });

  test('is empty once the game is over', () => {
    const game = start(STANDARD_FEN);
    playAll(game, ['f2f3', 'e7e5', 'g2g4', 'd8h4']);
    assert.equal(game.legalMoves().size, 0);
  });
});

describe('play', () => {
  test('plays a legal move and records it in SAN', () => {
    const game = start(STANDARD_FEN);
    assert.deepEqual(game.play(move('e2e4')), { ok: true, san: 'e4', uci: 'e2e4' });
    assert.equal(game.turn, 'black');
    assert.deepEqual(game.moves, ['e4']);
    assert.equal(game.fen, 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1');
  });

  test('refuses an illegal move and leaves the game unchanged', () => {
    const game = start(STANDARD_FEN);
    assert.deepEqual(game.play(move('e2e5')), { ok: false, error: 'illegal' });
    assert.deepEqual(game.play(move('e7e5')), { ok: false, error: 'illegal' }); // Black's pawn on White's turn
    assert.deepEqual(game.play(move('e3e4')), { ok: false, error: 'illegal' }); // empty square
    assert.equal(game.fen, STANDARD_FEN);
    assert.deepEqual(game.moves, []);
  });

  test('needs the promotion piece when a pawn promotes, and only then', () => {
    const fen = '8/4P3/8/8/8/k7/8/4K3 w - - 0 1';
    assert.deepEqual(start(fen).play(move('e7e8')), { ok: false, error: 'illegal' });
    assert.deepEqual(start(fen).play(move('e7e8q')), { ok: true, san: 'e8=Q', uci: 'e7e8q' });
    assert.deepEqual(start(fen).play(move('e7e8n')), { ok: true, san: 'e8=N', uci: 'e7e8n' });
    assert.deepEqual(start(STANDARD_FEN).play(move('e2e4q')), { ok: false, error: 'illegal' });
  });

  test('refuses any move once the game is over', () => {
    const game = start(STANDARD_FEN);
    playAll(game, ['f2f3', 'e7e5', 'g2g4', 'd8h4']);
    assert.deepEqual(game.play(move('e1f2')), { ok: false, error: 'gameOver' });
  });

  test('returns a copy of the move list', () => {
    const game = start(STANDARD_FEN);
    playAll(game, ['e2e4']);
    (game.moves as string[]).push('nonsense');
    assert.deepEqual(game.moves, ['e4']);
  });
});

describe('isLegal', () => {
  test('agrees with play, without playing', () => {
    const game = start(STANDARD_FEN);
    assert.equal(game.isLegal(move('e2e4')), true);
    assert.equal(game.isLegal(move('e2e5')), false);
    assert.equal(game.isLegal(move('e2e4q')), false);
    assert.equal(game.fen, STANDARD_FEN);
    assert.equal(start('8/4P3/8/8/8/k7/8/4K3 w - - 0 1').isLegal(move('e7e8')), false);
    assert.equal(start('8/4P3/8/8/8/k7/8/4K3 w - - 0 1').isLegal(move('e7e8r')), true);
  });

  test('is false once the game is over', () => {
    const game = start(STANDARD_FEN);
    playAll(game, ['f2f3', 'e7e5', 'g2g4', 'd8h4']);
    assert.equal(game.isLegal(move('e1f2')), false);
  });
});

describe('uciMoves', () => {
  test('records each move in UCI, castling as the king’s move and promotions with their piece', () => {
    const game = start('r3k3/1P6/8/8/8/8/8/R3K2R w KQq - 0 1');
    playAll(game, ['e1g1', 'a8a7', 'b7b8n']);
    assert.deepEqual(game.moves, ['O-O', 'Ra7', 'b8=N']);
    assert.deepEqual(game.uciMoves, ['e1g1', 'a8a7', 'b7b8n']);
  });

  test('is rebuilt by replay', () => {
    assert.deepEqual(ChessGame.replay(STANDARD_FEN, ['e4', 'e5', 'Nf3']).uciMoves, ['e2e4', 'e7e5', 'g1f3']);
  });
});

describe('endings', () => {
  test('checkmate, with the winner', () => {
    const game = start(STANDARD_FEN);
    playAll(game, ['f2f3', 'e7e5', 'g2g4', 'd8h4']);
    assert.deepEqual(game.moves, ['f3', 'e5', 'g4', 'Qh4#']);
    assert.equal(game.isCheck, true);
    assert.deepEqual(game.outcome, { termination: 'checkmate', winner: 'black' });
  });

  test('stalemate', () => {
    const game = start('7k/8/6K1/8/8/8/8/5Q2 w - - 0 1');
    playAll(game, ['f1f7']);
    assert.deepEqual(game.outcome, { termination: 'stalemate' });
  });

  test('insufficient material, by the same rule as Lichess', () => {
    const game = start('4k3/8/8/8/8/8/3r4/4K3 w - - 0 1');
    playAll(game, ['e1d2']);
    assert.deepEqual(game.outcome, { termination: 'insufficientMaterial' });
    // Kings and bishops all on one colour cannot mate; on both colours, or with two knights, they can.
    assert.equal(ChessGame.fromFen('4kb2/8/8/8/8/8/8/2B1K3 w - - 0 1').ok, false);
    assert.equal(start('4k1b1/8/8/8/8/8/8/2B1K3 w - - 0 1').outcome, undefined);
    assert.equal(start('4k3/8/8/8/8/8/8/3NKN2 w - - 0 1').outcome, undefined);
  });

  test('the fifty-move rule, automatically at 100 half-moves as on Lichess', () => {
    const game = start('4k3/8/8/8/8/8/8/R3K3 w - - 99 80');
    playAll(game, ['a1a2']);
    assert.deepEqual(game.outcome, { termination: 'fiftyMoves' });
  });

  test('checkmate on the hundredth half-move is checkmate, not a draw', () => {
    const game = start('7k/8/6K1/8/8/8/8/R7 w - - 99 80');
    playAll(game, ['a1a8']);
    assert.deepEqual(game.outcome, { termination: 'checkmate', winner: 'white' });
  });

  test('threefold repetition lets a player claim a draw but does not end the game', () => {
    const game = start(STANDARD_FEN);
    playAll(game, [...KNIGHT_SHUFFLE, ...KNIGHT_SHUFFLE.slice(0, 3)]);
    assert.equal(game.canClaimThreefold, false);
    playAll(game, [KNIGHT_SHUFFLE[3]!]);
    assert.equal(game.canClaimThreefold, true);
    assert.equal(game.outcome, undefined);
    playAll(game, ['e2e4']);
    assert.equal(game.canClaimThreefold, false, 'only the position on the board can be claimed');
  });

  test('fivefold repetition ends the game automatically', () => {
    const game = start(STANDARD_FEN);
    playAll(game, [...KNIGHT_SHUFFLE, ...KNIGHT_SHUFFLE, ...KNIGHT_SHUFFLE, ...KNIGHT_SHUFFLE.slice(0, 3)]);
    assert.equal(game.outcome, undefined);
    playAll(game, [KNIGHT_SHUFFLE[3]!]);
    assert.deepEqual(game.outcome, { termination: 'fivefoldRepetition' });
    assert.equal(game.canClaimThreefold, false);
  });
});

describe('ChessGame.replay', () => {
  test('rebuilds a game from its starting FEN and moves', () => {
    const played = start(STANDARD_FEN);
    playAll(played, ['e2e4', 'c7c5', 'g1f3', 'd7d6', 'd2d4', 'c5d4', 'f3d4', 'g8f6', 'b1c3', 'a7a6']);
    const replayed = ChessGame.replay(STANDARD_FEN, played.moves);
    assert.equal(replayed.fen, played.fen);
    assert.deepEqual(replayed.moves, played.moves);
  });

  test('carries repetitions across, so a restart cannot reset the count', () => {
    const replayed = ChessGame.replay(STANDARD_FEN, ['Nf3', 'Nf6', 'Ng1', 'Ng8', 'Nf3', 'Nf6', 'Ng1', 'Ng8']);
    assert.equal(replayed.canClaimThreefold, true);
  });

  test('throws on a stored move that is not legal', () => {
    assert.throws(() => ChessGame.replay(STANDARD_FEN, ['e4', 'e4']), /Stored move 2 \(e4\) is not legal/);
  });

  test('throws on a stored move after the end of the game', () => {
    assert.throws(
      () => ChessGame.replay(STANDARD_FEN, ['f3', 'e5', 'g4', 'Qh4#', 'Kf2']),
      /Stored move 5 \(Kf2\) follows the end of the game/,
    );
  });

  test('throws on a stored starting FEN that is not valid', () => {
    assert.throws(
      () => ChessGame.replay('8/8/8/8/8/8/8/4K3 w - - 0 1', []),
      /Stored starting FEN is not valid/,
    );
  });
});
