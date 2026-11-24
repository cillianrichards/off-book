import assert from 'node:assert/strict';
import { test } from 'node:test';

import { routeOf } from './route.ts';

test('reads the home page, with or without a trailing slash', () => {
  assert.deepEqual(routeOf('/'), { page: 'home' });
  assert.deepEqual(routeOf(''), { page: 'home' });
});

test('reads a game page at the game id, as lila does', () => {
  assert.deepEqual(routeOf('/abcD1234'), { page: 'game', id: 'abcD1234' });
  assert.deepEqual(routeOf('/abcD1234/'), { page: 'game', id: 'abcD1234' });
});

test('finds nothing at any other address', () => {
  for (const path of ['/abc', '/abcd12345', '/abcd-234', '/abcd1234/pgn', '/api/games/abcd1234']) {
    assert.deepEqual(routeOf(path), { page: 'notFound' }, path);
  }
});
