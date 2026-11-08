import { randomInt } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** A new game id: eight random letters and digits, as lila's game ids are. */
export function newGameId(): string {
  return Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
}

export const GAME_ID = /^[0-9A-Za-z]{8}$/;
