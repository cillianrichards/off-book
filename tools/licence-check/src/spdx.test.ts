import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { canonicalId, isAllowed, parse, SpdxError } from './spdx.ts';

const allowed = new Set(['mit', 'apache-2.0', 'gpl-3.0-or-later', 'gpl-2.0-or-later']);
const allows = (text: string): boolean => isAllowed(parse(text), allowed);

describe('canonicalId', () => {
  test('makes deprecated GNU identifiers explicit', () => {
    assert.equal(canonicalId('GPL-3.0'), 'GPL-3.0-only');
    assert.equal(canonicalId('GPL-2.0+'), 'GPL-2.0-or-later');
    assert.equal(canonicalId('LGPL-2.1+'), 'LGPL-2.1-or-later');
    assert.equal(canonicalId('AGPL-3.0'), 'AGPL-3.0-only');
  });

  test('leaves current identifiers alone', () => {
    assert.equal(canonicalId('MIT'), 'MIT');
    assert.equal(canonicalId('GPL-3.0-or-later'), 'GPL-3.0-or-later');
    assert.equal(canonicalId('Apache-2.0+'), 'Apache-2.0+');
  });
});

describe('parse', () => {
  test('binds AND tighter than OR', () => {
    assert.deepEqual(parse('MIT OR Apache-2.0 AND Zlib'), {
      kind: 'or',
      left: { kind: 'licence', id: 'MIT' },
      right: {
        kind: 'and',
        left: { kind: 'licence', id: 'Apache-2.0' },
        right: { kind: 'licence', id: 'Zlib' },
      },
    });
  });

  test('honours parentheses and WITH', () => {
    assert.deepEqual(parse('(MIT OR GPL-2.0-only WITH Classpath-exception-2.0)'), {
      kind: 'or',
      left: { kind: 'licence', id: 'MIT' },
      right: { kind: 'with', id: 'GPL-2.0-only', exception: 'Classpath-exception-2.0' },
    });
  });

  test('accepts lower-case operators, as some packages write them', () => {
    assert.deepEqual(parse('MIT or Apache-2.0'), parse('MIT OR Apache-2.0'));
  });

  for (const text of [
    '',
    'SEE LICENSE IN LICENSE.md',
    'MIT License',
    '(MIT',
    'MIT OR',
    'MIT AND OR Zlib',
    'WITH',
  ]) {
    test(`rejects ${JSON.stringify(text)}`, () => {
      assert.throws(() => parse(text), SpdxError);
    });
  }
});

describe('isAllowed', () => {
  test('a single allowed licence passes, matched case-insensitively', () => {
    assert.ok(allows('MIT'));
    assert.ok(allows('mit'));
  });

  test('an unlisted licence fails', () => {
    assert.ok(!allows('GPL-2.0-only'));
    assert.ok(!allows('UNLICENSED'));
  });

  test('a deprecated GNU identifier is read as its -only form', () => {
    assert.ok(!allows('GPL-2.0'));
    assert.ok(allows('GPL-2.0+'));
  });

  test('OR needs one allowed branch; AND needs all', () => {
    assert.ok(allows('GPL-2.0-only OR MIT'));
    assert.ok(!allows('GPL-2.0-only AND MIT'));
    assert.ok(allows('(MIT AND Apache-2.0) OR SSPL-1.0'));
  });

  test('an exception never makes an allowed licence disallowed, nor the reverse', () => {
    assert.ok(allows('Apache-2.0 WITH LLVM-exception'));
    assert.ok(!allows('GPL-2.0-only WITH Classpath-exception-2.0'));
  });

  test('"or later" is allowed when the named version is', () => {
    assert.ok(allows('Apache-2.0+'));
  });
});
