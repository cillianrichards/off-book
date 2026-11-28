// Tests say who they are with an `x-test-user` header, or, from a browser, which cannot set headers on a
// WebSocket, an `off-book-test-user` cookie. Only test code uses this: the live entry point has no way to
// identify anyone until sign-in (P2-02).

import type { IncomingMessage } from 'node:http';

import type { Authenticate } from '../server.ts';

export const TEST_USER_HEADER = 'x-test-user';
export const TEST_USER_COOKIE = 'off-book-test-user';

export const testAuthenticate: Authenticate = async (request: IncomingMessage) => {
  const user = request.headers[TEST_USER_HEADER];
  if (typeof user === 'string') return user;
  for (const part of (request.headers.cookie ?? '').split(';')) {
    const [name, ...rest] = part.trim().split('=');
    const value = rest.join('=');
    if (name === TEST_USER_COOKIE && value !== '') return decodeURIComponent(value);
  }
  return undefined;
};
