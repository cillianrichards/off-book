// The live server as the process tests run it (P2-08): the same start-up and shutdown as main.ts, but
// players identify themselves with a header, and OFF_BOOK_SAVE_DELAY_MS can shorten the save delay.
// Never run this anywhere but a test.

import { run } from '../run.ts';
import { testAuthenticate } from './test-auth.ts';

const delay = process.env.OFF_BOOK_SAVE_DELAY_MS;
await run({ authenticate: testAuthenticate, ...(delay === undefined ? {} : { saveDelayMs: Number(delay) }) });
