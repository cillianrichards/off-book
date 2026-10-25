import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  normalisePythonName,
  npmDirect,
  npmInstalled,
  type PythonDistribution,
  pythonDirect,
  pythonInstalled,
  pythonLicence,
} from './inventory.ts';

const dist = (overrides: Partial<PythonDistribution>): PythonDistribution => ({
  name: 'example',
  version: '1.0',
  licenseExpression: null,
  license: null,
  classifiers: [],
  ...overrides,
});

describe('npmInstalled', () => {
  test('lists one package per installed version and treats "Unknown" as no licence', () => {
    const packages = npmInstalled({
      MIT: [{ name: 'a', versions: ['1.0.0', '2.0.0'], license: 'MIT' }],
      Unknown: [{ name: 'b', versions: ['0.1.0'], license: 'Unknown' }],
    });
    assert.deepEqual(
      packages.map(p => [p.name, p.version, p.licence]),
      [
        ['a', '1.0.0', 'MIT'],
        ['a', '2.0.0', 'MIT'],
        ['b', '0.1.0', undefined],
      ],
    );
  });
});

describe('npmDirect', () => {
  test('collects every dependency section and skips workspace packages', () => {
    const direct = npmDirect(
      {
        dependencies: { 'chess.js': '^1.4.0', '@off-book/rules': 'workspace:*' },
        devDependencies: { typescript: 'catalog:' },
        optionalDependencies: { fsevents: '^2.0.0' },
        peerDependencies: { react: '>=19', 'chess.js': '^1.4.0' },
      },
      'apps/client/package.json',
    );
    assert.deepEqual(direct.map(d => d.name).sort(), ['chess.js', 'fsevents', 'react', 'typescript']);
    assert.ok(direct.every(d => d.ecosystem === 'npm' && d.declaredIn === 'apps/client/package.json'));
  });

  test('a manifest with no dependencies declares none', () => {
    assert.deepEqual(npmDirect({}, 'package.json'), []);
  });
});

describe('normalisePythonName', () => {
  test('follows PEP 503', () => {
    assert.equal(normalisePythonName('Typing_Extensions'), 'typing-extensions');
    assert.equal(normalisePythonName('zope.interface'), 'zope-interface');
    assert.equal(normalisePythonName('a--b__c'), 'a-b-c');
  });
});

describe('pythonLicence', () => {
  test('prefers License-Expression', () => {
    assert.deepEqual(
      pythonLicence(
        dist({
          licenseExpression: 'MIT',
          license: 'BSD',
          classifiers: ['License :: OSI Approved :: BSD License'],
        }),
      ),
      { licence: 'MIT', source: 'License-Expression' },
    );
  });

  test('uses a License field that is an SPDX expression', () => {
    assert.deepEqual(pythonLicence(dist({ license: 'MIT' })), { licence: 'MIT', source: 'License' });
  });

  test('falls back to classifiers when License is prose or a whole licence text', () => {
    const mit = ['License :: OSI Approved :: MIT License'];
    assert.deepEqual(pythonLicence(dist({ license: 'MIT License', classifiers: mit })), {
      licence: 'MIT',
      source: 'classifiers',
    });
    assert.deepEqual(pythonLicence(dist({ license: 'Copyright (c)\nPermission is...', classifiers: mit })), {
      licence: 'MIT',
      source: 'classifiers',
    });
  });

  test('joins several classifiers with AND and ignores the bare "OSI Approved"', () => {
    assert.deepEqual(
      pythonLicence(
        dist({
          classifiers: [
            'License :: OSI Approved',
            'License :: OSI Approved :: MIT License',
            'License :: OSI Approved :: Mozilla Public License 2.0 (MPL 2.0)',
            'Programming Language :: Python',
          ],
        }),
      ),
      { licence: 'MIT AND MPL-2.0', source: 'classifiers' },
    );
  });

  test('gives no licence for a classifier that does not name one version', () => {
    const result = pythonLicence(dist({ classifiers: ['License :: OSI Approved :: BSD License'] }));
    assert.equal(result.licence, undefined);
    assert.match(result.source, /BSD License/);
  });

  test('treats setuptools\' "UNKNOWN" and no metadata as no licence', () => {
    assert.equal(pythonLicence(dist({ license: 'UNKNOWN' })).licence, undefined);
    assert.equal(pythonLicence(dist({})).licence, undefined);
  });
});

describe('python inventory', () => {
  const inventory = {
    project: 'off-book-pipeline',
    requirements: ['pytest>=9.1.1', 'Typing_Extensions[extra] ; python_version < "3.14"', 'ruff==0.17.2'],
    distributions: [
      dist({ name: 'off_book_pipeline', licenseExpression: 'AGPL-3.0-or-later' }),
      dist({ name: 'Pygments', version: '2.21.0', licenseExpression: 'BSD-2-Clause' }),
    ],
  };

  test('installed packages exclude the project itself and use normalised names', () => {
    assert.deepEqual(pythonInstalled(inventory), [
      {
        ecosystem: 'pypi',
        name: 'pygments',
        version: '2.21.0',
        licence: 'BSD-2-Clause',
        source: 'License-Expression',
      },
    ]);
  });

  test('direct dependencies are the names of the declared requirements', () => {
    assert.deepEqual(
      pythonDirect(inventory, 'pipeline/pyproject.toml').map(d => d.name),
      ['pytest', 'typing-extensions', 'ruff'],
    );
  });

  test('an unreadable requirement is an error, not a silent omission', () => {
    assert.throws(() => pythonDirect({ ...inventory, requirements: ['>=1.0'] }, 'pyproject.toml'));
  });
});
