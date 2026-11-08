// The live server's network edge (P2-05): one Node.js process serving the HTTP API and the game
// WebSocket. Everything behind it is a module boundary inside the same process.
//
// HTTP:      GET /health              liveness, for the host's probes
//            GET /api/games/:id       a game as anyone may see it
// WebSocket: /play/:id                a player's connection to their game, as lila's round socket is

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';

import { type RawData, type WebSocket, WebSocketServer } from 'ws';

import { GAME_ID, type GameService, type PlayerSocket } from './game/index.ts';
import { errorFields, type Log } from './log.ts';

/**
 * Works out which Off Book user made a request, or undefined if none. Sign-in arrives with P2-02; until
 * then the live entry point identifies no one.
 */
export type Authenticate = (request: IncomingMessage) => Promise<string | undefined>;

export interface ServerOptions {
  readonly port: number;
  readonly host?: string;
  readonly games: GameService;
  readonly authenticate: Authenticate;
  readonly log: Log;
  /** How often to ping each WebSocket; one that has not answered the previous ping is dropped. */
  readonly heartbeatMs?: number;
}

export interface RunningServer {
  readonly port: number;
  /** Stops accepting connections and closes every WebSocket, telling clients the server is restarting. */
  close(): Promise<void>;
}

// Close code 1012, "service restart": the client should reconnect.
const SERVICE_RESTART = 1012;
// A move intent is a few dozen bytes; anything near this limit is not a client of ours.
const MAX_MESSAGE_BYTES = 4096;

export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const { games, authenticate, log } = options;
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  const alive = new WeakSet<WebSocket>();

  const http = createServer((request, response) => {
    handleHttp(request, response, games).catch((error: unknown) => {
      log.error('http request failed', { url: request.url, ...errorFields(error) });
      if (!response.headersSent) json(response, 500, { error: 'Internal error' });
      else response.destroy();
    });
  });

  http.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    upgrade(request, socket, head).catch((error: unknown) => {
      log.error('websocket upgrade failed', { url: request.url, ...errorFields(error) });
      refuse(socket, 500, 'Internal Server Error');
    });
  });

  async function upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const match = /^\/play\/([^/]+)$/.exec(pathOf(request));
    const gameId = match?.[1];
    if (gameId === undefined || !GAME_ID.test(gameId)) return refuse(socket, 404, 'Not Found');
    const userId = await authenticate(request);
    if (userId === undefined) return refuse(socket, 401, 'Unauthorized');
    const joined = await games.join(gameId, userId);
    if (!joined.ok)
      return refuse(
        socket,
        joined.error === 'notFound' ? 404 : 403,
        joined.error === 'notFound' ? 'Not Found' : 'Forbidden',
      );

    sockets.handleUpgrade(request, socket, head, ws => {
      alive.add(ws);
      ws.on('pong', () => alive.add(ws));
      const player: PlayerSocket = {
        send: message => {
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
        },
        close: (code, reason) => ws.close(code, reason),
      };
      const connection = joined.attach(player);
      ws.on('message', (data, isBinary) => {
        if (isBinary) player.send({ t: 'rejected', reason: 'badMessage' });
        else connection.receive(textOf(data));
      });
      ws.on('close', () => connection.closed());
      ws.on('error', error => log.warn('websocket error', { game: gameId, ...errorFields(error) }));
    });
  }

  // A connection that drops without closing never fires 'close'; pinging finds it.
  const heartbeat = setInterval(() => {
    for (const ws of sockets.clients) {
      if (!alive.has(ws)) {
        ws.terminate();
        continue;
      }
      alive.delete(ws);
      ws.ping();
    }
  }, options.heartbeatMs ?? 30_000);

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(options.port, options.host, () => {
      http.off('error', reject);
      resolve();
    });
  });

  return {
    port: (http.address() as AddressInfo).port,
    async close() {
      clearInterval(heartbeat);
      for (const ws of sockets.clients) ws.close(SERVICE_RESTART, 'Server restarting');
      const closed = new Promise<void>(resolve => http.close(() => resolve()));
      http.closeAllConnections();
      await closed;
    },
  };
}

async function handleHttp(
  request: IncomingMessage,
  response: ServerResponse,
  games: GameService,
): Promise<void> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.setHeader('Allow', 'GET, HEAD');
    return json(response, 405, { error: 'Method not allowed' });
  }
  const path = pathOf(request);
  if (path === '/health') return json(response, 200, { status: 'ok' });
  const game = /^\/api\/games\/([^/]+)$/.exec(path)?.[1];
  if (game !== undefined && GAME_ID.test(game)) {
    const view = await games.view(game);
    return view === undefined ? json(response, 404, { error: 'No such game' }) : json(response, 200, view);
  }
  return json(response, 404, { error: 'Not found' });
}

// A text frame as a string. `ws` hands over a Buffer by default, but its type also allows fragments.
function textOf(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.isBuffer(data) ? data.toString('utf8') : Buffer.from(data).toString('utf8');
}

function pathOf(request: IncomingMessage): string {
  return new URL(request.url ?? '/', 'http://localhost').pathname;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  response.end(response.req.method === 'HEAD' ? undefined : text);
}

function refuse(socket: Duplex, status: number, text: string): void {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}
