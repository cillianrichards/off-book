// A player's WebSocket to their game, at /play/:id (P2-15, P2-09). It reconnects whenever the connection
// drops, and the server answers every new connection with the whole game, from which the page rebuilds.
// It pings every few seconds to estimate network lag, and reports that lag with each move, which the
// server credits back up to a quota (P2-07).

import type { ClientMessage, ServerMessage } from '@off-book/protocol';

export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting';

/** The part of the browser's WebSocket used here, so tests can stand in for it. */
export interface SocketLike {
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  send(data: string): void;
  close(): void;
}

export interface Scheduler {
  now(): number;
  every(ms: number, run: () => void): () => void;
  after(ms: number, run: () => void): () => void;
}

export interface ConnectionOptions {
  readonly url: string;
  readonly onMessage: (message: ServerMessage) => void;
  readonly onStatus: (status: ConnectionStatus) => void;
  readonly createSocket?: (url: string) => SocketLike;
  readonly scheduler?: Scheduler;
}

export interface GameConnection {
  send(message: ClientMessage): void;
  close(): void;
}

const PING_EVERY_MS = 3000;
// Reconnection waits double from half a second up to five, as a dropped phone connection may take a while.
const FIRST_RETRY_MS = 500;
const LAST_RETRY_MS = 5000;
// How much each new round trip moves the average.
const LAG_WEIGHT = 0.25;

const browserScheduler: Scheduler = {
  now: () => performance.now(),
  every: (ms, run) => {
    const timer = setInterval(run, ms);
    return () => clearInterval(timer);
  },
  after: (ms, run) => {
    const timer = setTimeout(run, ms);
    return () => clearTimeout(timer);
  },
};

/** The game's WebSocket address on the page's own origin. */
export function gameSocketUrl(location: { protocol: string; host: string }, gameId: string): string {
  return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/play/${gameId}`;
}

export function connectToGame(options: ConnectionOptions): GameConnection {
  const createSocket = options.createSocket ?? ((url: string) => new WebSocket(url) as unknown as SocketLike);
  const scheduler = options.scheduler ?? browserScheduler;
  let socket: SocketLike | undefined;
  let open = false;
  let closed = false;
  let retryMs = FIRST_RETRY_MS;
  let stopPinging: (() => void) | undefined;
  let pingSentAt: number | undefined;
  let averageRoundTrip: number | undefined;

  const connect = (): void => {
    const current = createSocket(options.url);
    socket = current;
    current.onopen = () => {
      open = true;
      retryMs = FIRST_RETRY_MS;
      options.onStatus('open');
      stopPinging = scheduler.every(PING_EVERY_MS, ping);
    };
    current.onmessage = event => {
      if (typeof event.data !== 'string') return;
      let message: ServerMessage;
      try {
        message = JSON.parse(event.data) as ServerMessage;
      } catch {
        return;
      }
      if (message.t === 'pong') measured();
      options.onMessage(message);
    };
    current.onclose = () => {
      open = false;
      stopPinging?.();
      pingSentAt = undefined;
      if (closed) return;
      options.onStatus('reconnecting');
      scheduler.after(retryMs, connect);
      retryMs = Math.min(retryMs * 2, LAST_RETRY_MS);
    };
  };

  const ping = (): void => {
    if (!open || pingSentAt !== undefined) return;
    pingSentAt = scheduler.now();
    socket?.send(JSON.stringify({ t: 'ping' }));
  };

  const measured = (): void => {
    if (pingSentAt === undefined) return;
    const roundTrip = scheduler.now() - pingSentAt;
    pingSentAt = undefined;
    averageRoundTrip =
      averageRoundTrip === undefined
        ? roundTrip
        : averageRoundTrip + LAG_WEIGHT * (roundTrip - averageRoundTrip);
  };

  options.onStatus('connecting');
  connect();

  return {
    send(message) {
      if (!open || socket === undefined) return;
      // One-way lag is about half the round trip.
      const withLag =
        message.t === 'move' && averageRoundTrip !== undefined
          ? { ...message, lag: Math.round(averageRoundTrip / 2) }
          : message;
      socket.send(JSON.stringify(withLag));
    },
    close() {
      closed = true;
      stopPinging?.();
      socket?.close();
    },
  };
}
