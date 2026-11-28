import assert from 'node:assert/strict';
import { test } from 'node:test';

import { STANDARD_FEN } from '@off-book/rules';
import type { GameView, ServerMessage } from '@off-book/protocol';

import {
  applyMessage,
  needsPromotion,
  numberedMoves,
  playMove,
  positionOf,
  roundFromState,
} from './round.ts';

// After 1.d4 d5 2.c4 e6 3.Nc3 Nf6 4.Bg5 Nbd7 5.e3 c6 6.Nf3: Black to move, move 6.
const BLACK_TO_MOVE = 'r1bqkb1r/pp1n1ppp/2p1pn2/3p2B1/2PP4/2N1PN2/PP3PPP/R2QKB1R b KQkq - 1 6';
// White to move with a pawn on b7 ready to promote.
const PROMOTING = '4k3/1P6/8/8/8/8/8/4K3 w - - 0 1';

const CLOCK = { initialSeconds: 600, incrementSeconds: 0, white: 60_000, black: 60_000, running: false };

function view(overrides: Partial<GameView> = {}): GameView {
  return {
    id: 'abcd1234',
    players: { white: 'alice', black: 'bob' },
    initialFen: STANDARD_FEN,
    fen: STANDARD_FEN,
    moves: [],
    ply: 0,
    turn: 'white',
    status: 'started',
    clock: CLOCK,
    ...overrides,
  };
}

const state = (overrides: Partial<GameView> = {}, you: 'white' | 'black' = 'white') =>
  roundFromState({ t: 'state', you, game: view(overrides), opponent: { connected: true } });

const moveMessage = (ply: number, san: string, uci: string, fen: string): ServerMessage => ({
  t: 'move',
  ply,
  san,
  uci,
  fen,
  clock: { white: 59_000, black: 60_000, running: true },
});

const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';

test('rebuilds the position from the server’s moves, from any starting FEN', () => {
  const round = state(
    { initialFen: BLACK_TO_MOVE, fen: BLACK_TO_MOVE, moves: ['Qa5', 'Nd2'], ply: 2 },
    'black',
  );
  const position = positionOf(round);
  assert.equal(position.turn, 'black');
  assert.deepEqual(position.moves, ['Qa5', 'Nd2']);
  assert.deepEqual(position.lastMove, ['f3', 'd2']);
  assert.ok(position.dests.size > 0, 'Black, to move, has legal moves');
});

test('offers no moves to the player whose turn it is not', () => {
  assert.equal(positionOf(state({}, 'black')).dests.size, 0);
  assert.ok(positionOf(state({}, 'white')).dests.has('e2'));
});

test('keeps the player’s move on the board until the server confirms it, without a second sound', () => {
  const sent = playMove(state(), 'e2', 'e4');
  assert.ok(sent);
  assert.deepEqual(sent.message, { t: 'move', ply: 0, uci: 'e2e4' });
  assert.deepEqual(positionOf(sent.round).moves, ['e4'], 'shown at once');
  assert.equal(positionOf(sent.round).dests.size, 0, 'nothing more to move while waiting');

  const confirmed = applyMessage(sent.round, moveMessage(0, 'e4', 'e2e4', AFTER_E4));
  assert.equal(confirmed.round.pending, undefined);
  assert.deepEqual(confirmed.round.game.moves, ['e4']);
  assert.deepEqual(confirmed.effects, []);
});

test('plays a sound for the opponent’s move, and lets a premove go once it is the player’s turn', () => {
  const round = state({}, 'black');
  const after = applyMessage(round, moveMessage(0, 'e4', 'e2e4', AFTER_E4));
  assert.deepEqual(after.effects, [{ type: 'sound', sound: 'move' }, { type: 'playPremove' }]);
  assert.equal(after.round.game.turn, 'black');
  assert.deepEqual(after.round.game.clock, { ...CLOCK, white: 59_000, running: true });
});

test('a capture sounds like one', () => {
  const round = state({ moves: ['e4', 'd5'], ply: 2, turn: 'white' }, 'black');
  const after = applyMessage(round, moveMessage(2, 'exd5', 'e4d5', STANDARD_FEN));
  assert.deepEqual(after.effects[0], { type: 'sound', sound: 'capture' });
});

test('asks for the whole game again when a move was missed, and ignores one it already has', () => {
  const round = state({ moves: ['e4'], ply: 1, turn: 'black' }, 'white');
  assert.deepEqual(applyMessage(round, moveMessage(3, 'Nf3', 'g1f3', STANDARD_FEN)).effects, [
    { type: 'send', message: { t: 'resync' } },
  ]);
  const repeat = applyMessage(round, moveMessage(0, 'e4', 'e2e4', AFTER_E4));
  assert.equal(repeat.round, round);
  assert.deepEqual(repeat.effects, []);
});

test('puts a refused move back and asks for the whole game', () => {
  const sent = playMove(state(), 'e2', 'e4');
  assert.ok(sent);
  const refused = applyMessage(sent.round, { t: 'rejected', reason: 'stale', ply: 1 });
  assert.equal(refused.round.pending, undefined);
  assert.deepEqual(positionOf(refused.round).moves, []);
  assert.deepEqual(refused.effects, [{ type: 'send', message: { t: 'resync' } }]);
});

test('a new state replaces everything, pending move included', () => {
  const sent = playMove(state(), 'e2', 'e4');
  assert.ok(sent);
  const fresh = applyMessage(sent.round, {
    t: 'state',
    you: 'white',
    game: view({ moves: ['d4'], ply: 1, turn: 'black' }),
    opponent: { connected: false, claimableAt: 5 },
  });
  assert.equal(fresh.round.pending, undefined);
  assert.deepEqual(positionOf(fresh.round).moves, ['d4']);
  assert.deepEqual(fresh.round.opponent, { connected: false, claimableAt: 5 });
});

test('refuses moves that are illegal, out of turn, or after the game', () => {
  assert.equal(playMove(state(), 'e2', 'e5'), undefined);
  assert.equal(playMove(state({}, 'black'), 'e7', 'e5'), undefined);
  assert.equal(
    playMove(state({ status: 'finished', result: '1-0', termination: 'flag' }), 'e2', 'e4'),
    undefined,
  );
  const sent = playMove(state(), 'e2', 'e4');
  assert.ok(sent);
  assert.equal(playMove(sent.round, 'd2', 'd4'), undefined, 'one move at a time');
});

test('knows when a promotion piece is needed, and sends the one chosen', () => {
  const round = state({ initialFen: PROMOTING, fen: PROMOTING });
  assert.equal(needsPromotion(round, 'b7', 'b8'), true);
  assert.equal(needsPromotion(round, 'e1', 'e2'), false);
  assert.equal(playMove(round, 'b7', 'b8'), undefined, 'a promotion without a piece is not a move');
  assert.deepEqual(playMove(round, 'b7', 'b8', 'n')?.message, { t: 'move', ply: 0, uci: 'b7b8n' });
});

test('ends the game on the server’s word, and offers no more moves', () => {
  const ended = applyMessage(state(), {
    t: 'end',
    status: 'finished',
    result: '0-1',
    termination: 'flag',
    clock: { white: 0, black: 50_000, running: false },
  });
  assert.equal(ended.round.game.status, 'finished');
  assert.equal(ended.round.game.result, '0-1');
  assert.equal(positionOf(ended.round).playing, false);
  assert.equal(positionOf(ended.round).dests.size, 0);
});

test('numbers the move list from the starting FEN, Black first if Black starts', () => {
  assert.deepEqual(numberedMoves(STANDARD_FEN, ['e4', 'e5', 'Nf3']), [
    { number: 1, white: 'e4', black: 'e5' },
    { number: 2, white: 'Nf3' },
  ]);
  assert.deepEqual(numberedMoves(BLACK_TO_MOVE, ['Qa5', 'Nd2', 'Bb4']), [
    { number: 6, black: 'Qa5' },
    { number: 7, white: 'Nd2', black: 'Bb4' },
  ]);
  assert.deepEqual(numberedMoves(BLACK_TO_MOVE, []), []);
});

test('resends a move the server refused while restarting, once it is back', () => {
  const sent = playMove(state(), 'e2', 'e4');
  assert.ok(sent);
  const refused = applyMessage(sent.round, { t: 'rejected', reason: 'restarting' });
  assert.deepEqual(refused.round.pending, { ply: 0, uci: 'e2e4' }, 'kept through the restart');
  assert.deepEqual(refused.effects, []);
  const back = applyMessage(refused.round, {
    t: 'state',
    you: 'white',
    game: view(),
    opponent: { connected: true },
  });
  assert.deepEqual(back.round.pending, { ply: 0, uci: 'e2e4' });
  assert.deepEqual(back.effects, [{ type: 'send', message: { t: 'move', ply: 0, uci: 'e2e4' } }]);
});

test('drops a pending move the server already has when the connection comes back', () => {
  const sent = playMove(state(), 'e2', 'e4');
  assert.ok(sent);
  const back = applyMessage(sent.round, {
    t: 'state',
    you: 'white',
    game: view({ moves: ['e4'], ply: 1, turn: 'black', fen: AFTER_E4 }),
    opponent: { connected: true },
  });
  assert.equal(back.round.pending, undefined);
  assert.deepEqual(back.effects, []);
  assert.deepEqual(positionOf(back.round).moves, ['e4']);
});
