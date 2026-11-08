// The in-process event bus (P2-11), as lila's Bus: modules announce what happened and others listen,
// without importing each other. There is no outbox (D-03): events are published once the change they
// describe is saved, and a crash in between loses the event, as on Lichess.

import { errorFields, type Log } from './log.ts';

export interface Event {
  readonly type: string;
}

type Handler<E> = (event: E) => void;

export class Bus<E extends Event> {
  readonly #log: Log;
  readonly #handlers = new Map<string, Set<Handler<E>>>();

  constructor(log: Log) {
    this.#log = log;
  }

  /** Calls `handler` with every event of `type` from now on, until the returned function is called. */
  subscribe<T extends E['type']>(type: T, handler: Handler<Extract<E, { type: T }>>): () => void {
    const handlers = this.#handlers.get(type) ?? new Set();
    const wrapped = handler as Handler<E>;
    handlers.add(wrapped);
    this.#handlers.set(type, handlers);
    return () => handlers.delete(wrapped);
  }

  /** Hands the event to each listener in turn. One that throws is logged and does not stop the rest. */
  publish(event: E): void {
    for (const handler of this.#handlers.get(event.type) ?? []) {
      try {
        handler(event);
      } catch (error) {
        this.#log.error('an event listener failed', { event: event.type, ...errorFields(error) });
      }
    }
  }
}
