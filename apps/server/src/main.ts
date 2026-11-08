// Starts the live server: `pnpm --filter @off-book/server start`.
//
// Environment:
//   PORT   the port to listen on (default 8080)

import { GameService } from './game/index.ts';
import { errorFields, jsonLog as log } from './log.ts';
import { type Authenticate, startServer } from './server.ts';
import { realTime } from './time.ts';

// Nobody can sign in until P2-02, so every WebSocket is refused with 401 for now.
const noSignInYet: Authenticate = async () => undefined;

function portFromEnvironment(): number {
  const text = process.env.PORT ?? '8080';
  const port = Number(text);
  if (!/^\d+$/.test(text) || port > 65_535) throw new Error(`PORT must be a port number, not "${text}".`);
  return port;
}

const games = new GameService({ time: realTime, log });
const server = await startServer({ port: portFromEnvironment(), games, authenticate: noSignInYet, log });
log.info('listening', { port: server.port });

let stopping = false;
async function stop(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log.info('stopping', { signal });
  try {
    await server.close();
    log.info('stopped');
  } catch (error) {
    log.error('stop failed', errorFields(error));
    process.exitCode = 1;
  }
}

process.once('SIGTERM', () => void stop('SIGTERM'));
process.once('SIGINT', () => void stop('SIGINT'));
