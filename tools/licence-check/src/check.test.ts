import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';

import { type Allowlist, check, loadAllowlist } from './check.ts';
import type { DirectDependency, InstalledPackage } from './inventory.ts';

const allowlist: Allowlist = {
  licences: { MIT: 'permissive', 'GPL-3.0-or-later': 'section 13' },
  overrides: [],
};

const npm = (name: string, licence: string | undefined, version = '1.0.0'): InstalledPackage => ({
  ecosystem: 'npm',
  name,
  version,
  licence,
  source: 'package.json',
});

const direct = (name: string, ecosystem: 'npm' | 'pypi' = 'npm'): DirectDependency => ({
  ecosystem,
  name,
  declaredIn: 'package.json',
});

const kinds = (problems: readonly { kind: string }[]): string[] => problems.map(p => p.kind);

describe('check', () => {
  test('passes when every licence is allowed and every direct dependency is registered', () => {
    const problems = check(
      [npm('a', 'MIT'), npm('b', 'GPL-3.0-or-later OR MIT')],
      [direct('a')],
      allowlist,
      new Set(['npm:a']),
    );
    assert.deepEqual(problems, []);
  });

  test('fails a transitive package whose licence is not allowed', () => {
    const problems = check([npm('a', 'GPL-2.0-only')], [], allowlist, new Set());
    assert.deepEqual(kinds(problems), ['not-allowed']);
    assert.match(problems[0]?.message ?? '', /npm a@1\.0\.0: GPL-2\.0-only/);
  });

  test('fails a package with no licence or a licence that is not an SPDX expression', () => {
    const problems = check(
      [npm('a', undefined), npm('b', 'SEE LICENSE IN LICENSE.md')],
      [],
      allowlist,
      new Set(),
    );
    assert.deepEqual(kinds(problems), ['no-licence', 'no-licence']);
  });

  test('fails a direct dependency missing from the register, once however often it is declared', () => {
    const problems = check(
      [npm('a', 'MIT')],
      [direct('a'), direct('a'), direct('pytest', 'pypi')],
      allowlist,
      new Set(['npm:other']),
    );
    assert.deepEqual(kinds(problems), ['unregistered', 'unregistered']);
    assert.match(problems[1]?.message ?? '', /`pytest` \(PyPI\)/);
  });

  test('matches PyPI names in the register after normalisation', () => {
    const problems = check(
      [],
      [direct('Typing_Extensions', 'pypi')],
      allowlist,
      new Set(['pypi:typing-extensions']),
    );
    assert.deepEqual(problems, []);
  });

  test('an override supplies the licence for exactly that version', () => {
    const withOverride: Allowlist = {
      ...allowlist,
      overrides: [
        { ecosystem: 'npm', name: 'a', version: '1.0.0', licence: 'MIT', reason: 'checked LICENSE' },
      ],
    };
    assert.deepEqual(check([npm('a', undefined)], [], withOverride, new Set()), []);
    assert.deepEqual(kinds(check([npm('a', undefined, '2.0.0')], [], withOverride, new Set())), [
      'no-licence',
      'unused-override',
    ]);
  });

  test('an override licence is itself checked against the allowlist', () => {
    const withOverride: Allowlist = {
      ...allowlist,
      overrides: [{ ecosystem: 'npm', name: 'a', version: '1.0.0', licence: 'SSPL-1.0', reason: 'checked' }],
    };
    assert.deepEqual(kinds(check([npm('a', 'MIT')], [], withOverride, new Set())), ['not-allowed']);
  });
});

describe('loadAllowlist', () => {
  test('accepts a well-formed allowlist', () => {
    const loaded = loadAllowlist({
      licences: { MIT: 'permissive' },
      overrides: [{ ecosystem: 'pypi', name: 'x', version: '1', licence: 'MIT', reason: 'checked' }],
    });
    assert.equal(loaded.overrides.length, 1);
  });

  for (const [what, json] of [
    ['a deprecated identifier', { licences: { 'GPL-3.0': 'x' }, overrides: [] }],
    ['an "or later" plus', { licences: { 'Apache-2.0+': 'x' }, overrides: [] }],
    ['a licence without a reason', { licences: { MIT: ' ' }, overrides: [] }],
    [
      'an override without a reason',
      { licences: {}, overrides: [{ ecosystem: 'npm', name: 'a', version: '1', licence: 'MIT' }] },
    ],
    [
      'an override with an invalid licence',
      {
        licences: {},
        overrides: [{ ecosystem: 'npm', name: 'a', version: '1', licence: 'MIT License', reason: 'x' }],
      },
    ],
    ['a missing overrides list', { licences: {} }],
  ] as const) {
    test(`rejects ${what}`, () => {
      assert.throws(() => loadAllowlist(json));
    });
  }

  test('the repository allowlist is valid', () => {
    const file = path.join(import.meta.dirname, '..', 'allowlist.json');
    const loaded = loadAllowlist(JSON.parse(readFileSync(file, 'utf8')));
    assert.ok('AGPL-3.0-or-later' in loaded.licences);
  });
});
