import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { test } from 'node:test';

import { testAuthenticate } from './test-auth.ts';

const request = (headers: Record<string, string>) => ({ headers }) as unknown as IncomingMessage;

test('test users name themselves by header or, from a browser, by cookie', async () => {
  assert.equal(await testAuthenticate(request({ 'x-test-user': 'alice' })), 'alice');
  assert.equal(await testAuthenticate(request({ cookie: 'theme=dark; off-book-test-user=bob' })), 'bob');
  assert.equal(await testAuthenticate(request({ cookie: 'off-book-test-user=a%20b' })), 'a b');
  assert.equal(await testAuthenticate(request({ cookie: 'off-book-test-user=' })), undefined);
  assert.equal(await testAuthenticate(request({})), undefined);
});
