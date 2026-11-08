// A player socket for service tests: it records what the service sends.

import type { PlayerSocket, ServerMessage } from '../game/index.ts';

export class FakeSocket implements PlayerSocket {
  readonly sent: ServerMessage[] = [];
  closedWith: { code: number; reason: string } | undefined;

  send(message: ServerMessage): void {
    this.sent.push(message);
  }

  close(code: number, reason: string): void {
    this.closedWith = { code, reason };
  }

  /** Everything sent since the last call. */
  take(): ServerMessage[] {
    return this.sent.splice(0);
  }

  /** The messages of one type sent since the last `take`, without taking them. */
  of<T extends ServerMessage['t']>(t: T): Extract<ServerMessage, { t: T }>[] {
    return this.sent.filter((message): message is Extract<ServerMessage, { t: T }> => message.t === t);
  }
}
