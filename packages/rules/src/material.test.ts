// The positions are scalachess's own tests (InsufficientMatingMaterialTest), so the rule matches Lichess's.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  bishopsOnOppositeColours,
  hasInsufficientMatingMaterial,
  materialImbalance,
  piecesOf,
} from './material.ts';

const sideNotToMove = (fen: string): 'w' | 'b' => (fen.split(' ')[1] === 'w' ? 'b' : 'w');

describe('bishopsOnOppositeColours', () => {
  test('finds bishops on both colours, whichever side has them', () => {
    for (const fen of [
      '8/4b3/8/8/8/8/4B3/8 w - - 0 1',
      '8/4b3/8/8/2Q5/1K6/4B3/5B2 w - - 0 1',
      '5b2/1k2b1n1/3q4/8/2Q5/1K6/4B3/5B2 w - - 0 1',
      '6b1/1k3bn1/3q4/8/2Q5/1K6/4bB2/8 w - - 0 1',
      '6b1/1k3bn1/3B4/8/2Q2B2/1K6/4bB2/8 w - - 0 1',
      '2k2b2/5b2/8/8/8/3R4/1K2Q3/5B2 w - - 0 1',
      '2k2b2/6b1/7b/8/8/3R2B1/1K2Q3/5B2 w - - 0 1',
      '2k5/8/8/8/8/3R2B1/1K2Q3/5B2 w - - 0 1',
    ]) {
      assert.equal(bishopsOnOppositeColours(piecesOf(fen)), true, fen);
    }
  });

  test('and not when they share a colour, or there is at most one', () => {
    for (const fen of [
      '4b3/8/8/8/8/8/4B3/8 w - - 0 1',
      '5b2/8/8/8/8/3R4/1K2QB2/8 w - - 0 1',
      '8/8/8/8/8/3R4/1K2B3/8 w - - 0 1',
      '5b2/8/8/8/8/3R4/1K2Q3/8 w - - 0 1',
    ]) {
      assert.equal(bishopsOnOppositeColours(piecesOf(fen)), false, fen);
    }
  });
});

describe('hasInsufficientMatingMaterial, for the side not to move', () => {
  test('is true where scalachess says that side cannot mate', () => {
    for (const fen of [
      '8/6R1/K7/2NNN3/5NN1/4KN2/8/k7 w - - 0 1',
      '8/8/K7/8/1k6/8/8/8 w - - 0 1',
      '7k/8/8/8/3K4/8/8/8 w - - 0 1',
      '7k/5R2/5NQ1/8/3K4/8/8/8 w - - 0 1',
      'krq5/bqqq4/qqr5/1qq5/8/8/8/3qB2K b - -',
      '8/3k4/2q5/8/8/K1N5/8/8 b - -',
      '7k/8/6Q1/8/3K4/8/1n6/8 w - - 0 1',
    ]) {
      assert.equal(hasInsufficientMatingMaterial(piecesOf(fen), sideNotToMove(fen)), true, fen);
    }
  });

  test('is false where scalachess says that side can', () => {
    for (const fen of [
      'krq5/bqqq4/qqrp4/1qq5/8/8/8/3qB2K b - - 0 1',
      '8/7B/K7/2b5/1k6/8/8/8 b - -',
      '8/8/K7/2b5/1k6/5N2/8/8 b - - 0 1',
      '7k/5R2/5NQ1/8/3K4/8/1p6/8 w - - 0 1',
      '7k/5R2/5NQ1/8/3K4/8/2n5/8 w - - 0 1',
      '7k/5R2/5NQ1/8/3K4/1r6/8/8 w - - 0 1',
      '7k/8/8/5R2/3K4/8/1n6/8 w - - 0 1',
      '7k/8/6B1/8/3K4/8/1n6/8 w - - 0 1',
      '7k/5P2/8/8/3K4/8/1n6/8 w - - 0 1',
      '7k/6N1/8/8/3K4/8/1n6/8 w - - 0 1',
    ]) {
      assert.equal(hasInsufficientMatingMaterial(piecesOf(fen), sideNotToMove(fen)), false, fen);
    }
  });
});

describe('materialImbalance', () => {
  test('is White’s material minus Black’s, in pawns', () => {
    assert.equal(materialImbalance(piecesOf('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1')), 0);
    assert.equal(materialImbalance(piecesOf('4k3/8/8/8/8/8/8/R3K3 w - - 0 1')), 5);
    assert.equal(materialImbalance(piecesOf('3qk3/8/8/8/8/8/P7/4K3 w - - 0 1')), -8);
  });
});
