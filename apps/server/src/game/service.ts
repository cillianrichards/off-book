// The game service: the sole authority on board state and clocks. Live games are held in memory, as
// lila holds them (D-01), and saved to PostgreSQL as they change (P2-08). Clients only propose; the
// service decides and tells both players.

import type { Colour } from '@off-book/rules';

import { errorFields, type Log } from '../log.ts';
import type { Time, Timer } from '../time.ts';
import { newGameId } from './ids.ts';
import { type ClockSettings, type Ending, type GameView, LiveGame } from './live-game.ts';
import {
  type ClientMessage,
  type OpponentStatus,
  parseClientMessage,
  type ServerMessage,
} from './protocol.ts';
import type { GameStore } from './store.ts';

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
  readonly store: GameStore;
  /** How long a move may wait to be saved, unless the game's status changes first (P2-08). */
  readonly saveDelayMs?: number;
}

interface Entry {
  readonly game: LiveGame;
  readonly sockets: Record<Colour, Set<PlayerSocket>>;
  /** When each player's last socket closed, or undefined while they have one open (P2-10). */
  readonly offlineSince: Record<Colour, number | undefined>;
  /** The server's own check for the side to move's flag (P2-07). */
  flagCheck?: Timer;
  /** The pending save of moves not yet written (P2-08). */
  saveTimer?: Timer;
  /** Every save of this game, chained so that each writes a later state than the one before. */
  saving: Promise<void>;
}

// D-01: a move is saved within 30 seconds, the delay lila's GameProxy uses.
const SAVE_DELAY_MS = 30_000;
// lila's finisher aborts rather than flags a game whose last move came before the server started, if the
// server started less than two minutes ago: its clock ran out because the server was down.
const RESTART_GRACE_MS = 120_000;
// On a clean shutdown lila gives the side to move 20 seconds and the other side 10.
const SHUTDOWN_ALLOWANCE_CS = { toMove: 2000, other: 1000 } as const;

const other = (colour: Colour): Colour => (colour === 'white' ? 'black' : 'white');

export class GameService {
  readonly #time: Time;
  readonly #log: Log;
  readonly #store: GameStore;
  readonly #saveDelayMs: number;
  readonly #games = new Map<string, Entry>();
  readonly #startedAt: number;
  #stopping = false;

  constructor(options: GameServiceOptions) {
    this.#time = options.time;
    this.#log = options.log;
    this.#store = options.store;
    this.#saveDelayMs = options.saveDelayMs ?? SAVE_DELAY_MS;
    this.#startedAt = this.#time.now();
  }

  /**
   * Reloads every game still being played, after a restart (P2-08). A game whose clock ran out while the
   * server was down ends at once, aborted if the server has only just started, as lila does.
   */
  async resume(): Promise<number> {
    let resumed = 0;
    for (const record of await this.#store.loadStarted()) {
      let game: LiveGame;
      try {
        game = LiveGame.restore(record);
      } catch (error) {
        this.#log.error('a saved game could not be restored', { game: record.id, ...errorFields(error) });
        continue;
      }
      this.#checkFlag(this.#add(game));
      resumed += 1;
    }
    this.#log.info('games resumed', { count: resumed });
    return resumed;
  }

  async create(input: CreateGame): Promise<CreatedGame> {
    // A clash between random eight-character ids is all but impossible, but costs only a retry.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const created = LiveGame.create({ ...input, id: newGameId(), now: this.#time.now() });
      if (!created.ok) return created;
      const { game } = created;
      if ((await this.#store.insert(game.toRecord())) === 'duplicateId') continue;
      this.#add(game);
      this.#log.info('game created', { game: game.id });
      return { ok: true, id: game.id };
    }
    throw new Error('Could not find an unused game id');
  }

  async view(id: string): Promise<GameView | undefined> {
    const live = this.#games.get(id);
    if (live !== undefined) return live.game.view(this.#time.now());
    const record = await this.#store.load(id);
    return record === undefined ? undefined : LiveGame.restore(record).view(this.#time.now());
  }

  async join(id: string, userId: string): Promise<Join> {
    const entry = await this.#entry(id);
    if (entry === undefined) return { ok: false, error: 'notFound' };
    const colour = entry.game.colourOf(userId);
    if (colour === undefined) return { ok: false, error: 'notAPlayer' };
    return { ok: true, attach: socket => this.#attach(entry, colour, socket) };
  }

  /**
   * A clean shutdown (P2-08): every game in play gets lila's allowance, 20 seconds for the side to move
   * and 10 for the other, and is saved. Intents arriving afterwards are refused.
   */
  async shutdown(): Promise<void> {
    this.#stopping = true;
    for (const entry of this.#games.values()) {
      entry.flagCheck?.cancel();
      if (entry.game.status !== 'started') continue;
      entry.game.giveTime(entry.game.turn, SHUTDOWN_ALLOWANCE_CS.toMove);
      entry.game.giveTime(other(entry.game.turn), SHUTDOWN_ALLOWANCE_CS.other);
      void this.#save(entry);
    }
    await this.settled();
    for (const entry of this.#games.values()) entry.saveTimer?.cancel();
  }

  /** Stops every timer without saving anything, as a crash would. For tests. */
  halt(): void {
    this.#stopping = true;
    for (const entry of this.#games.values()) {
      entry.flagCheck?.cancel();
      entry.saveTimer?.cancel();
    }
  }

  /** Resolves once every save already started has finished. */
  async settled(): Promise<void> {
    await Promise.all([...this.#games.values()].map(entry => entry.saving));
  }

  async #entry(id: string): Promise<Entry | undefined> {
    const live = this.#games.get(id);
    if (live !== undefined) return live;
    // Games in play are all in memory since `resume`; this loads a finished one for its players to see.
    const record = await this.#store.load(id);
    if (record === undefined) return undefined;
    return this.#games.get(id) ?? this.#add(LiveGame.restore(record));
  }

  #add(game: LiveGame): Entry {
    // Both players count as away until they connect, as in lila, including after a restart.
    const now = this.#time.now();
    const entry: Entry = {
      game,
      sockets: { white: new Set(), black: new Set() },
      offlineSince: { white: now, black: now },
      saving: Promise.resolve(),
    };
    this.#games.set(game.id, entry);
    return entry;
  }

  #attach(entry: Entry, colour: Colour, socket: PlayerSocket): Connection {
    entry.sockets[colour].add(socket);
    if (entry.offlineSince[colour] !== undefined) {
      entry.offlineSince[colour] = undefined;
      this.#sendTo(entry, other(colour), { t: 'opponent', connected: true });
    }
    socket.send(this.#state(entry, colour));
    return {
      receive: text => {
        const message = parseClientMessage(text);
        if (message === undefined) socket.send({ t: 'rejected', reason: 'badMessage' });
        else if (this.#stopping) socket.send({ t: 'rejected', reason: 'restarting' });
        else this.#handle(entry, colour, message, socket);
      },
      closed: () => {
        entry.sockets[colour].delete(socket);
        if (entry.sockets[colour].size === 0) {
          entry.offlineSince[colour] = this.#time.now();
          this.#sendTo(entry, other(colour), { t: 'opponent', ...this.#statusOf(entry, colour) });
        }
        this.#forgetIfDone(entry);
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
      case 'resync':
        socket.send(this.#state(entry, colour));
        break;
      case 'claim': {
        // Abandonment (P2-10): the opponent has been gone long enough, and it is their turn.
        const gone = this.#statusOf(entry, other(colour)).claimableAt;
        const ending =
          gone !== undefined && gone <= now ? game.abandon(colour, message.outcome, now) : undefined;
        if (ending === undefined) socket.send({ t: 'rejected', reason: 'notClaimable', ply: game.ply });
        else this.#finish(entry, ending);
        break;
      }
      case 'move': {
        const outcome = game.move(colour, { ply: message.ply, uci: message.uci, lagMs: message.lag }, now);
        if (outcome.kind === 'duplicate') socket.send({ t: 'ack', ply: outcome.ply });
        else if (outcome.kind === 'rejected')
          socket.send({ t: 'rejected', reason: outcome.reason, ply: game.ply });
        else if (outcome.kind === 'flagged') this.#finish(entry, this.#timeRanOut(entry, now));
        else {
          const { ply, san, uci, fen, clock } = outcome;
          this.#broadcast(entry, { t: 'move', ply, san, uci, fen, clock });
          if (outcome.ending !== undefined) this.#finish(entry, outcome.ending);
          else {
            // Each side's first move is a status change and is saved at once (D-01); later moves wait.
            if (game.ply <= 2) void this.#save(entry);
            else this.#saveSoon(entry);
            this.#scheduleFlagCheck(entry);
          }
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
    if (due === undefined || this.#stopping) return;
    entry.flagCheck = this.#time.after(due - this.#time.now(), () => this.#checkFlag(entry));
  }

  #checkFlag(entry: Entry): void {
    const now = this.#time.now();
    if (entry.game.isOutOfTime(now)) this.#finish(entry, this.#timeRanOut(entry, now));
    else this.#scheduleFlagCheck(entry);
  }

  // The side to move is out of time. Just after a restart, with their last move made before it, the
  // clock ran out because the server was down, so lila aborts the game rather than flag it (P2-08).
  #timeRanOut(entry: Entry, now: number): Ending {
    const { game } = entry;
    const lastMove = game.lastMoveAt ?? game.createdAt;
    const justRestarted = now - this.#startedAt < RESTART_GRACE_MS && lastMove < this.#startedAt;
    return justRestarted ? game.abortAfterRestart(now) : game.flag(now);
  }

  #finish(entry: Entry, ending: Ending): void {
    entry.flagCheck?.cancel();
    this.#log.info('game ended', { game: entry.game.id, ...ending });
    this.#broadcast(entry, { t: 'end', ...ending, clock: entry.game.clockAt(this.#time.now()) });
    void this.#save(entry).then(() => this.#forgetIfDone(entry));
  }

  // Moves are saved within the delay of the first one not yet saved, so a crash loses at most that much.
  #saveSoon(entry: Entry): void {
    entry.saveTimer ??= this.#time.after(this.#saveDelayMs, () => void this.#save(entry));
  }

  /** Saves the game as it stands now, after any save already under way. A failed save is retried. */
  #save(entry: Entry): Promise<void> {
    entry.saveTimer?.cancel();
    entry.saveTimer = undefined;
    const record = entry.game.toRecord();
    entry.saving = entry.saving.then(async () => {
      try {
        await this.#store.update(record);
      } catch (error) {
        this.#log.error('saving a game failed; retrying', { game: record.id, ...errorFields(error) });
        if (!this.#stopping) this.#saveSoon(entry);
      }
    });
    return entry.saving;
  }

  // A game that is over and that nobody is watching leaves memory; it can be loaded again if wanted.
  #forgetIfDone(entry: Entry): void {
    const watched = entry.sockets.white.size + entry.sockets.black.size > 0;
    if (entry.game.status !== 'started' && !watched && entry.saveTimer === undefined) {
      this.#games.delete(entry.game.id);
    }
  }

  #state(entry: Entry, colour: Colour): ServerMessage {
    const game = entry.game.view(this.#time.now());
    return { t: 'state', you: colour, game, opponent: this.#statusOf(entry, other(colour)) };
  }

  // Whether a player is connected, and if not, when their opponent may claim the game.
  #statusOf(entry: Entry, colour: Colour): OpponentStatus {
    const since = entry.offlineSince[colour];
    if (since === undefined) return { connected: true };
    if (entry.game.status !== 'started') return { connected: false };
    return { connected: false, claimableAt: since + entry.game.goneAfterMs(colour) };
  }

  #sendTo(entry: Entry, colour: Colour, message: ServerMessage): void {
    for (const socket of entry.sockets[colour]) socket.send(message);
  }

  #broadcast(entry: Entry, message: ServerMessage): void {
    for (const socket of [...entry.sockets.white, ...entry.sockets.black]) socket.send(message);
  }
}
