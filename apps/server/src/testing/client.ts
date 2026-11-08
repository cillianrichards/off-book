// A game WebSocket client for tests: it queues every message, so a test can wait for the next one.

import WebSocket from 'ws';

import type { ServerMessage } from '../game/index.ts';

export interface TestClient {
  /** The next message not yet taken, waiting up to `timeoutMs` for it. */
  next(timeoutMs?: number): Promise<ServerMessage>;
  /** Takes messages until one of type `t` arrives, and returns it. */
  nextOf<T extends ServerMessage['t']>(t: T, timeoutMs?: number): Promise<Extract<ServerMessage, { t: T }>>;
  /** Messages received and not yet taken. */
  readonly queued: readonly ServerMessage[];
  send(message: unknown): void;
  sendText(text: string): void;
  close(): Promise<void>;
  /** Resolves with the close code once the server closes the connection. */
  readonly closedBy: Promise<number>;
}

export type Opened =
  | { readonly ok: true; readonly client: TestClient }
  | { readonly ok: false; readonly status: number };

export function openClient(url: string, headers: Record<string, string> = {}): Promise<Opened> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    const queued: ServerMessage[] = [];
    const waiting: ((message: ServerMessage) => void)[] = [];
    let closeCode: (code: number) => void = () => {};
    const closedBy = new Promise<number>(done => {
      closeCode = done;
    });

    ws.on('message', data => {
      const buffer = Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.isBuffer(data)
          ? data
          : Buffer.from(data);
      const text = buffer.toString('utf8');
      const message = JSON.parse(text) as ServerMessage;
      const waiter = waiting.shift();
      if (waiter === undefined) queued.push(message);
      else waiter(message);
    });
    ws.on('close', code => closeCode(code));
    ws.once('unexpected-response', (_request, response) =>
      resolve({ ok: false, status: response.statusCode ?? 0 }),
    );
    ws.once('error', reject);

    const next = (timeoutMs = 2000): Promise<ServerMessage> => {
      const message = queued.shift();
      if (message !== undefined) return Promise.resolve(message);
      return new Promise((done, fail) => {
        const timer = setTimeout(() => fail(new Error(`No message within ${timeoutMs} ms`)), timeoutMs);
        waiting.push(received => {
          clearTimeout(timer);
          done(received);
        });
      });
    };

    const client: TestClient = {
      next,
      async nextOf(t, timeoutMs) {
        for (;;) {
          const message = await next(timeoutMs);
          if (message.t === t) return message as Extract<ServerMessage, { t: typeof t }>;
        }
      },
      queued,
      send: message => ws.send(JSON.stringify(message)),
      sendText: text => ws.send(text),
      close: () =>
        new Promise(done => {
          if (ws.readyState === ws.CLOSED) return done();
          ws.once('close', () => done());
          ws.close();
        }),
      closedBy,
    };
    ws.once('open', () => resolve({ ok: true, client }));
  });
}
