// Reads THIRD_PARTY_LICENCES.md. A package counts as registered when a table row names it as
// `name` (npm) or `name` (PyPI); prose mentions do not count.

import { type Ecosystem, packageKey } from './inventory.ts';

const entry = /`([^`\s]+)` \((npm|PyPI)\)/g;

const ecosystems: Readonly<Record<string, Ecosystem>> = { npm: 'npm', PyPI: 'pypi' };

/** Keys (see `packageKey`) of every package named in a table row of the register. */
export function registeredPackages(markdown: string): Set<string> {
  const keys = new Set<string>();
  for (const line of markdown.split('\n')) {
    if (!line.trimStart().startsWith('|')) continue;
    for (const [, name, registry] of line.matchAll(entry)) {
      const ecosystem = registry === undefined ? undefined : ecosystems[registry];
      if (name !== undefined && ecosystem !== undefined) keys.add(packageKey(ecosystem, name));
    }
  }
  return keys;
}
