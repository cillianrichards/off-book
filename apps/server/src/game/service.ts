// The game service: the sole authority on board state and clocks, holding every live game in memory
// (D-01). Clients only propose; the service decides and tells both players.

import type { Colour } from '@off-book/rules';

import type { Log } from '../log.ts';
import type { Time, Timer } from '../time.ts';
import { newGameId } from './ids.ts';
import { type ClockSettings, type Ending, type GameView, LiveGame } from './live-game.ts';
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
  /** The server's own check for the side to move's flag (P2-07). */
  flagCheck?: Timer;
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
        else this.#handle(entry, colour, message, socket);
      },
      closed: () => {
        entry.sockets[colour].delete(socket);
      },
    };
  }

  #handle(entry: Entry, colour: Colour, message: ClientMessage, socket: PlayerSocket): void {
    const { game } = entry;
    const now = this.#time.now();
    switch (message.t) {
      case 'ping':
        socket.send({ t: 'pong' });
        break;
      case 'move': {
        const outcome = game.move(colour, { ply: message.ply, uci: message.uci, lagMs: message.lag }, now);
        if (outcome.kind === 'duplicate') socket.send({ t: 'ack', ply: outcome.ply });
        else if (outcome.kind === 'rejected')
          socket.send({ t: 'rejected', reason: outcome.reason, ply: game.ply });
        else if (outcome.kind === 'flagged') this.#finish(entry, outcome.ending);
        else {
          const { ply, san, uci, fen, clock } = outcome;
          this.#broadcast(entry, { t: 'move', ply, san, uci, fen, clock });
          if (outcome.ending !== undefined) this.#finish(entry, outcome.ending);
          else this.#scheduleFlagCheck(entry);
        }
        break;
      }
      case 'abort': {
        const ending = game.abort(colour, now);
        if (ending === undefined) socket.send({ t: 'rejected', reason: 'notAllowed', ply: game.ply });
        else this.#finish(entry, ending);
        break;
      }
    }
  }

  // Flags are found by the server, not left to the clients (P2-07): a timer fires when the side to move
  // would be out of time, grace included, and checks again in case a move has arrived since.
  #scheduleFlagCheck(entry: Entry): void {
    entry.flagCheck?.cancel();
    const due = entry.game.flagCheckDueAt;
    if (due === undefined) return;
    entry.flagCheck = this.#time.after(due - this.#time.now(), () => {
      const ending = entry.game.flagIfOutOfTime(this.#time.now());
      if (ending === undefined) this.#scheduleFlagCheck(entry);
      else this.#finish(entry, ending);
    });
  }

  #finish(entry: Entry, ending: Ending): void {
    entry.flagCheck?.cancel();
    this.#log.info('game ended', { game: entry.game.id, ...ending });
    this.#broadcast(entry, { t: 'end', ...ending, clock: entry.game.clockAt(this.#time.now()) });
  }

  #broadcast(entry: Entry, message: ServerMessage): void {
    for (const socket of [...entry.sockets.white, ...entry.sockets.black]) socket.send(message);
  }
}
