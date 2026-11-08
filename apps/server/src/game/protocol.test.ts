import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseClientMessage } from './protocol.ts';

test('reads each kind of client message', () => {
  assert.deepEqual(parseClientMessage('{"t":"ping"}'), { t: 'ping' });
  assert.deepEqual(parseClientMessage('{"t":"abort"}'), { t: 'abort' });
  assert.deepEqual(parseClientMessage('{"t":"move","ply":0,"uci":"e2e4"}'), {
    t: 'move',
    ply: 0,
    uci: 'e2e4',
  });
  assert.deepEqual(parseClientMessage('{"t":"move","ply":12,"uci":"e7e8q"}'), {
    t: 'move',
    ply: 12,
    uci: 'e7e8q',
  });
});

test('keeps only the fields it knows', () => {
  assert.deepEqual(parseClientMessage('{"t":"move","ply":0,"uci":"e2e4","extra":true}'), {
    t: 'move',
    ply: 0,
    uci: 'e2e4',
  });
});

test('refuses anything that is not a client message', () => {
  for (const text of [
    'not json',
    'null',
    '[]',
    '"move"',
    '{}',
    '{"t":"resign"}',
    '{"t":"move","uci":"e2e4"}',
    '{"t":"move","ply":-1,"uci":"e2e4"}',
    '{"t":"move","ply":1.5,"uci":"e2e4"}',
    '{"t":"move","ply":"0","uci":"e2e4"}',
    '{"t":"move","ply":601,"uci":"e2e4"}',
    '{"t":"move","ply":0,"uci":"e2e9"}',
    '{"t":"move","ply":0,"uci":"e7e8k"}',
    '{"t":"move","ply":0}',
  ]) {
    assert.equal(parseClientMessage(text), undefined, text);
  }
});
