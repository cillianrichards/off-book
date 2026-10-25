import assert from 'node:assert/strict';
import { test } from 'node:test';

import { registeredPackages } from './register.ts';

const markdown = `
# Third-party licences

Prose mentioning \`left-pad\` (npm) does not register it.

| Component | Package | Licence |
| --- | --- | --- |
| chess.js | \`chess.js\` (npm) | BSD-2-Clause |
| Board | \`@lichess-org/chessground\` (npm) | GPL-3.0-or-later |
| Test runner | \`Typing_Extensions\` (PyPI), \`pytest\` (PyPI) | MIT |
| Stockfish | not a package | GPL-3.0-or-later |
`;

test('registers packages named in table rows, normalising PyPI names', () => {
  assert.deepEqual([...registeredPackages(markdown)].sort(), [
    'npm:@lichess-org/chessground',
    'npm:chess.js',
    'pypi:pytest',
    'pypi:typing-extensions',
  ]);
});

test('ignores names outside tables and without a registry', () => {
  const keys = registeredPackages(markdown);
  assert.ok(!keys.has('npm:left-pad'));
  assert.equal(keys.size, 4);
});
