import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Bus } from './bus.ts';
import { silentLog } from './log.ts';

type Events = { readonly type: 'a'; readonly n: number } | { readonly type: 'b'; readonly s: string };

test('hands each event to the listeners for its type, in order', () => {
  const bus = new Bus<Events>(silentLog);
  const seen: string[] = [];
  bus.subscribe('a', event => seen.push(`first ${event.n}`));
  bus.subscribe('a', event => seen.push(`second ${event.n}`));
  bus.subscribe('b', event => seen.push(`b ${event.s}`));
  bus.publish({ type: 'a', n: 1 });
  bus.publish({ type: 'b', s: 'x' });
  assert.deepEqual(seen, ['first 1', 'second 1', 'b x']);
});

test('stops calling a listener once it unsubscribes', () => {
  const bus = new Bus<Events>(silentLog);
  const seen: number[] = [];
  const unsubscribe = bus.subscribe('a', event => seen.push(event.n));
  bus.publish({ type: 'a', n: 1 });
  unsubscribe();
  bus.publish({ type: 'a', n: 2 });
  assert.deepEqual(seen, [1]);
});

test('a listener that throws does not stop the others, and is logged', () => {
  const logged: string[] = [];
  const bus = new Bus<Events>({ ...silentLog, error: message => logged.push(message) });
  const seen: number[] = [];
  bus.subscribe('a', () => {
    throw new Error('broken');
  });
  bus.subscribe('a', event => seen.push(event.n));
  bus.publish({ type: 'a', n: 1 });
  assert.deepEqual(seen, [1]);
  assert.deepEqual(logged, ['an event listener failed']);
});

test('an event nobody listens for goes nowhere', () => {
  new Bus<Events>(silentLog).publish({ type: 'b', s: 'unheard' });
});
