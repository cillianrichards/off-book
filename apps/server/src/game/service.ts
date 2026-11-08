// The game service: the sole authority on board state and clocks, holding every live game in memory
// (D-01). Clients only propose; the service decides and tells both players.

import type { Colour } from '@off-book/rules';

import type { Log } from '../log.ts';
import type { Time } from '../time.ts';
import { newGameId } from './ids.ts';
import { type ClockSettings, type GameView, LiveGame } from './live-game.ts';
import { type ClientMessage, parseClientMessage, type ServerMessage } from './protocol.ts';

/** One open WebSocket, as the game service sees it. */
export interface PlayerSocket {
  send(message: ServerMessage): void;
  close(code: number, reason: string): void;
}

/** What the WebSocket layer calls when a socket it attached receives a message or closes. */
export interface Connection {
  receive(text: string): void;
  closed(): void;
}

export type Join =
  | { readonly ok: true; attach(socket: PlayerSocket): Connection }
  | { readonly ok: false; readonly error: 'notFound' | 'notAPlayer' };

export interface CreateGame {
  readonly white: string;
  readonly black: string;
  readonly initialFen: string;
  readonly clock: ClockSettings;
}

export type CreatedGame =
  | { readonly ok: true; readonly id: string }
  | { readonly ok: false; readonly error: string };

export interface GameServiceOptions {
  readonly time: Time;
  readonly log: Log;
}

interface Entry {
  readonly game: LiveGame;
  readonly sockets: Record<Colour, Set<PlayerSocket>>;
}

export class GameService {
  readonly #time: Time;
  readonly #log: Log;
  readonly #games = new Map<string, Entry>();

  constructor(options: GameServiceOptions) {
    this.#time = options.time;
    this.#log = options.log;
  }

  async create(input: CreateGame): Promise<CreatedGame> {
    const created = LiveGame.create({ ...input, id: newGameId(), now: this.#time.now() });
    if (!created.ok) return created;
    const { game } = created;
    this.#games.set(game.id, { game, sockets: { white: new Set(), black: new Set() } });
    this.#log.info('game created', { game: game.id });
    return { ok: true, id: game.id };
  }

  async view(id: string): Promise<GameView | undefined> {
    return this.#games.get(id)?.game.view(this.#time.now());
  }

  async join(id: string, userId: string): Promise<Join> {
    const entry = this.#games.get(id);
    if (entry === undefined) return { ok: false, error: 'notFound' };
    const colour = entry.game.colourOf(userId);
    if (colour === undefined) return { ok: false, error: 'notAPlayer' };
    return { ok: true, attach: socket => this.#attach(entry, colour, socket) };
  }

  #attach(entry: Entry, colour: Colour, socket: PlayerSocket): Connection {
    entry.sockets[colour].add(socket);
    socket.send({ t: 'state', you: colour, game: entry.game.view(this.#time.now()) });
    return {
      receive: text => {
        const message = parseClientMessage(text);
        if (message === undefined) socket.send({ t: 'rejected', reason: 'badMessage' });
        else this.#handle(message, socket);
      },
      closed: () => {
        entry.sockets[colour].delete(socket);
      },
    };
  }

  #handle(message: ClientMessage, socket: PlayerSocket): void {
    switch (message.t) {
      case 'ping':
        socket.send({ t: 'pong' });
        break;
    }
  }
}
