// Starts the live server: `pnpm --filter @off-book/server start`, with DATABASE_URL set (see run.ts).

import type { Authenticate } from './server.ts';
import { run } from './run.ts';

// Nobody can sign in until P2-02, so every WebSocket is refused with 401 for now.
const noSignInYet: Authenticate = async () => undefined;

await run({ authenticate: noSignInYet });
