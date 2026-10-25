// Turns the raw output of pnpm and of python_inventory.py into one list of packages for the check.
// Everything here is pure; main.ts does the I/O.

import { parse, SpdxError } from './spdx.ts';

export type Ecosystem = 'npm' | 'pypi';

export interface InstalledPackage {
  readonly ecosystem: Ecosystem;
  readonly name: string;
  readonly version: string;
  /** The declared licence expression, or undefined when none could be found. */
  readonly licence: string | undefined;
  /** Where the licence was read from, for error messages. */
  readonly source: string;
}

export interface DirectDependency {
  readonly ecosystem: Ecosystem;
  readonly name: string;
  readonly declaredIn: string;
}

/** PEP 503 name normalisation, so that `Typing_Extensions` and `typing-extensions` match. */
export function normalisePythonName(name: string): string {
  return name.toLowerCase().replaceAll(/[-_.]+/g, '-');
}

export function packageKey(ecosystem: Ecosystem, name: string): string {
  return `${ecosystem}:${ecosystem === 'pypi' ? normalisePythonName(name) : name}`;
}

const absent = new Set(['', 'unknown', 'none']);

// npm

/** Shape of `pnpm -r licenses list --json`: licence → packages declaring it. */
export type PnpmLicences = Record<
  string,
  readonly { readonly name: string; readonly versions: readonly string[]; readonly license: string }[]
>;

export function npmInstalled(listing: PnpmLicences): InstalledPackage[] {
  return Object.values(listing).flatMap(entries =>
    entries.flatMap(entry =>
      entry.versions.map(version => ({
        ecosystem: 'npm' as const,
        name: entry.name,
        version,
        licence: absent.has(entry.license.trim().toLowerCase()) ? undefined : entry.license.trim(),
        source: 'package.json',
      })),
    ),
  );
}

export interface Manifest {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
}

/** Third-party dependencies declared in one package.json; workspace packages are ours, so excluded. */
export function npmDirect(manifest: Manifest, declaredIn: string): DirectDependency[] {
  const sections = [
    manifest.dependencies,
    manifest.devDependencies,
    manifest.optionalDependencies,
    manifest.peerDependencies,
  ];
  const names = new Set<string>();
  for (const section of sections) {
    for (const [name, spec] of Object.entries(section ?? {})) {
      if (!spec.startsWith('workspace:') && !spec.startsWith('link:')) names.add(name);
    }
  }
  return [...names].map(name => ({ ecosystem: 'npm', name, declaredIn }));
}

// Python

/** One installed distribution, as python_inventory.py reports it. */
export interface PythonDistribution {
  readonly name: string;
  readonly version: string;
  readonly licenseExpression: string | null;
  readonly license: string | null;
  readonly classifiers: readonly string[];
}

export interface PythonInventory {
  readonly project: string;
  readonly requirements: readonly string[];
  readonly distributions: readonly PythonDistribution[];
}

// Only classifiers that name one licence and one version. "BSD License" and "Apache Software License"
// do not say which, so a package that declares nothing better needs an override in the allowlist.
const classifierLicences: Readonly<Record<string, string>> = {
  'License :: OSI Approved :: MIT License': 'MIT',
  'License :: OSI Approved :: ISC License (ISCL)': 'ISC',
  'License :: OSI Approved :: Mozilla Public License 2.0 (MPL 2.0)': 'MPL-2.0',
  'License :: OSI Approved :: Python Software Foundation License': 'PSF-2.0',
  'License :: OSI Approved :: zlib/libpng License': 'Zlib',
  'License :: OSI Approved :: GNU General Public License v3 (GPLv3)': 'GPL-3.0-only',
  'License :: OSI Approved :: GNU General Public License v3 or later (GPLv3+)': 'GPL-3.0-or-later',
  'License :: OSI Approved :: GNU Lesser General Public License v3 (LGPLv3)': 'LGPL-3.0-only',
  'License :: OSI Approved :: GNU Lesser General Public License v3 or later (LGPLv3+)': 'LGPL-3.0-or-later',
  'License :: OSI Approved :: GNU Affero General Public License v3': 'AGPL-3.0-only',
  'License :: OSI Approved :: GNU Affero General Public License v3 or later (AGPLv3+)': 'AGPL-3.0-or-later',
  'License :: CC0 1.0 Universal (CC0 1.0) Public Domain Dedication': 'CC0-1.0',
};

function parses(text: string): boolean {
  try {
    parse(text);
    return true;
  } catch (error) {
    if (error instanceof SpdxError) return false;
    throw error;
  }
}

/**
 * The licence a distribution declares, preferring the PEP 639 `License-Expression`, then a `License`
 * field that is a valid SPDX expression, then licence classifiers. Several classifiers are combined
 * with AND, the cautious reading, since metadata does not say whether they are alternatives.
 */
export function pythonLicence(distribution: PythonDistribution): {
  licence: string | undefined;
  source: string;
} {
  const expression = distribution.licenseExpression?.trim() ?? '';
  if (!absent.has(expression.toLowerCase())) return { licence: expression, source: 'License-Expression' };

  const field = distribution.license?.trim() ?? '';
  if (!absent.has(field.toLowerCase()) && !field.includes('\n') && parses(field)) {
    return { licence: field, source: 'License' };
  }

  const classifiers = distribution.classifiers.filter(
    c => c.startsWith('License :: ') && c !== 'License :: OSI Approved',
  );
  if (classifiers.length === 0) return { licence: undefined, source: 'no licence metadata' };
  const unrecognised = classifiers.filter(c => !(c in classifierLicences));
  if (unrecognised.length > 0) {
    return { licence: undefined, source: `unrecognised classifier "${unrecognised.join('", "')}"` };
  }
  return { licence: classifiers.map(c => classifierLicences[c]).join(' AND '), source: 'classifiers' };
}

export function pythonInstalled(inventory: PythonInventory): InstalledPackage[] {
  const project = normalisePythonName(inventory.project);
  return inventory.distributions
    .filter(d => normalisePythonName(d.name) !== project)
    .map(d => ({
      ecosystem: 'pypi',
      name: normalisePythonName(d.name),
      version: d.version,
      ...pythonLicence(d),
    }));
}

const requirementName = /^\s*([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)/;

export function pythonDirect(inventory: PythonInventory, declaredIn: string): DirectDependency[] {
  const names = new Set<string>();
  for (const requirement of inventory.requirements) {
    const match = requirementName.exec(requirement);
    if (!match?.[1]) throw new Error(`cannot read a package name from requirement "${requirement}"`);
    names.add(normalisePythonName(match[1]));
  }
  return [...names].map(name => ({ ecosystem: 'pypi', name, declaredIn }));
}
