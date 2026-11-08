import { describe } from 'node:test';

import { MemoryGameStore } from './memory-store.ts';
import { storeContract } from './store-contract.ts';

describe('MemoryGameStore keeps the store contract', () => {
  const store = new MemoryGameStore();
  storeContract(() => store, new Set());
});
