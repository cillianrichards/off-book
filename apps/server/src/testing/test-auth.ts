// Tests say who they are with an `x-test-user` header. Only test code uses this: the live entry point has
// no way to identify anyone until sign-in (P2-02).

import type { IncomingMessage } from 'node:http';

import type { Authenticate } from '../server.ts';

export const TEST_USER_HEADER = 'x-test-user';

export const testAuthenticate: Authenticate = async (request: IncomingMessage) => {
  const user = request.headers[TEST_USER_HEADER];
  return typeof user === 'string' ? user : undefined;
};
