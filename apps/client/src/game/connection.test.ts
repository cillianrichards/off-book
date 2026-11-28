import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  connectToGame,
  type ConnectionStatus,
  gameSocketUrl,
  type Scheduler,
  type SocketLike,
} from './connection.ts';

class FakeSocket implements SocketLike {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  readonly sent: unknown[] = [];
  closed = false;
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(): void {
    this.closed = true;
    this.onclose?.();
  }
  receive(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

/** Time that moves only when told, running whatever falls due. */
class FakeScheduler implements Scheduler {
  time = 0;
  #tasks: { at: number; every?: number; run: () => void; live: boolean }[] = [];
  now(): number {
    return this.time;
  }
  every(ms: number, run: () => void): () => void {
    const task = { at: this.time + ms, every: ms, run, live: true };
    this.#tasks.push(task);
    return () => (task.live = false);
  }
  after(ms: number, run: () => void): () => void {
    const task = { at: this.time + ms, run, live: true };
    this.#tasks.push(task);
    return () => (task.live = false);
  }
  advance(ms: number): void {
    const until = this.time + ms;
    for (;;) {
      const due = this.#tasks.filter(task => task.live && task.at <= until).sort((a, b) => a.at - b.at)[0];
      if (due === undefined) break;
      this.time = due.at;
      if (due.every === undefined) due.live = false;
      else due.at += due.every;
      due.run();
    }
    this.time = until;
  }
}

function setup() {
  const sockets: FakeSocket[] = [];
  const statuses: ConnectionStatus[] = [];
  const messages: unknown[] = [];
  const scheduler = new FakeScheduler();
  const connection = connectToGame({
    url: 'ws://example/play/abcd1234',
    onMessage: message => messages.push(message),
    onStatus: status => statuses.push(status),
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    scheduler,
  });
  const current = () => sockets.at(-1) as FakeSocket;
  return { connection, sockets, statuses, messages, scheduler, current };
}

test('builds the WebSocket address on the page’s own origin', () => {
  assert.equal(
    gameSocketUrl({ protocol: 'https:', host: 'offbook.example' }, 'abcd1234'),
    'wss://offbook.example/play/abcd1234',
  );
  assert.equal(
    gameSocketUrl({ protocol: 'http:', host: 'localhost:5173' }, 'abcd1234'),
    'ws://localhost:5173/play/abcd1234',
  );
});

test('passes on what the server sends, and sends nothing until open', () => {
  const { connection, current, messages, statuses } = setup();
  connection.send({ t: 'resync' });
  assert.deepEqual(current().sent, [], 'not open yet');
  current().onopen?.();
  assert.deepEqual(statuses, ['connecting', 'open']);
  current().receive({ t: 'opponent', connected: true });
  assert.deepEqual(messages, [{ t: 'opponent', connected: true }]);
  connection.send({ t: 'resync' });
  assert.deepEqual(current().sent, [{ t: 'resync' }]);
});

test('measures lag by ping and reports half the round trip with each move', () => {
  const { connection, current, scheduler } = setup();
  current().onopen?.();
  connection.send({ t: 'move', ply: 0, uci: 'e2e4' });
  assert.deepEqual(current().sent, [{ t: 'move', ply: 0, uci: 'e2e4' }], 'no lag known yet');
  scheduler.advance(3000);
  assert.deepEqual(current().sent.at(-1), { t: 'ping' });
  scheduler.advance(120);
  current().receive({ t: 'pong' });
  connection.send({ t: 'move', ply: 2, uci: 'g1f3' });
  assert.deepEqual(current().sent.at(-1), { t: 'move', ply: 2, uci: 'g1f3', lag: 60 });
});

test('reconnects after a drop, waiting longer each time, and stops when closed', () => {
  const { connection, sockets, statuses, scheduler, current } = setup();
  current().onopen?.();
  current().onclose?.();
  assert.equal(statuses.at(-1), 'reconnecting');
  scheduler.advance(499);
  assert.equal(sockets.length, 1);
  scheduler.advance(1);
  assert.equal(sockets.length, 2, 'retries after half a second');
  current().onclose?.();
  scheduler.advance(999);
  assert.equal(sockets.length, 2);
  scheduler.advance(1);
  assert.equal(sockets.length, 3, 'then after a second');
  current().onopen?.();
  current().onclose?.();
  scheduler.advance(500);
  assert.equal(sockets.length, 4, 'a connection that opened starts the waits again');

  connection.close();
  assert.equal(current().closed, true);
  scheduler.advance(10_000);
  assert.equal(sockets.length, 4, 'no reconnecting once closed');
});
