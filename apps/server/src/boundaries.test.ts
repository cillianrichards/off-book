// P2-05: the services are module boundaries inside one process, so code outside a module reaches it only
// through its index.ts. That keeps each one liftable into its own service later (P6-12).

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SRC = dirname(fileURLToPath(import.meta.url));
const MODULES = ['game', 'pairing', 'lobby', 'rating', 'fair-play'];

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory()
      ? sourceFiles(join(dir, entry.name))
      : entry.name.endsWith('.ts')
        ? [join(dir, entry.name)]
        : [],
  );

const moduleOf = (file: string): string | undefined => {
  const [first] = relative(SRC, file).split(sep);
  return MODULES.includes(first ?? '') ? first : undefined;
};

const relativeImports = (file: string): string[] =>
  [...readFileSync(file, 'utf8').matchAll(/(?:from|import)\s*['"](\.[^'"]+)['"]/g)].map(
    match => match[1] ?? '',
  );

test('every module has an index.ts', () => {
  for (const name of MODULES) {
    assert.ok(
      sourceFiles(join(SRC, name)).includes(join(SRC, name, 'index.ts')),
      `${name}/index.ts is missing`,
    );
  }
});

// Whether `file` importing `specifier` reaches into another module past its index.ts.
const crossesBoundary = (file: string, specifier: string): boolean => {
  const target = resolve(dirname(file), specifier);
  const targetModule = moduleOf(target);
  if (targetModule === undefined || targetModule === moduleOf(file)) return false;
  return target !== join(SRC, targetModule, 'index.ts');
};

test('code outside a module imports it only through its index.ts', () => {
  const crossings = sourceFiles(SRC).flatMap(file =>
    relativeImports(file)
      .filter(specifier => crossesBoundary(file, specifier))
      .map(specifier => `${relative(SRC, file)} imports ${specifier}`),
  );
  assert.deepEqual(crossings, []);
});

test('the check tells a crossing from an allowed import', () => {
  assert.equal(crossesBoundary(join(SRC, 'server.ts'), './game/index.ts'), false);
  assert.equal(crossesBoundary(join(SRC, 'server.ts'), './game/service.ts'), true);
  assert.equal(crossesBoundary(join(SRC, 'game', 'service.ts'), './live-game.ts'), false);
  assert.equal(crossesBoundary(join(SRC, 'game', 'service.ts'), '../rating/index.ts'), false);
  assert.equal(crossesBoundary(join(SRC, 'game', 'service.ts'), '../rating/glicko.ts'), true);
  assert.equal(crossesBoundary(join(SRC, 'game', 'service.ts'), '../log.ts'), false);
  assert.ok(
    relativeImports(join(SRC, 'server.ts')).includes('./game/index.ts'),
    'the import scanner reads server.ts',
  );
});
