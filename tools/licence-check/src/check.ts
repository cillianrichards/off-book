// The licence check itself, as a pure function of what is installed, what is declared, the allowlist
// and the register.
//
// - Every installed package, direct or transitive, must declare a licence on the allowlist.
// - Every direct dependency must be named in THIRD_PARTY_LICENCES.md. Transitive packages are not,
//   because that register is written by hand; the shipped notices are generated (X-07).

import { type DirectDependency, type Ecosystem, type InstalledPackage, packageKey } from './inventory.ts';
import { canonicalId, isAllowed, parse, SpdxError } from './spdx.ts';

export interface Override {
  readonly ecosystem: Ecosystem;
  readonly name: string;
  readonly version: string;
  readonly licence: string;
  readonly reason: string;
}

export interface Allowlist {
  /** Canonical SPDX identifier → why it is compatible with AGPL-3.0-or-later. */
  readonly licences: Readonly<Record<string, string>>;
  /** Licences checked by hand for packages whose metadata does not declare one usably. */
  readonly overrides: readonly Override[];
}

export type ProblemKind = 'no-licence' | 'not-allowed' | 'unregistered' | 'unused-override';

export interface Problem {
  readonly kind: ProblemKind;
  readonly message: string;
}

const ecosystemLabel: Readonly<Record<Ecosystem, string>> = { npm: 'npm', pypi: 'PyPI' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Validates allowlist.json, so that a malformed allowlist fails loudly rather than allowing too much. */
export function loadAllowlist(json: unknown): Allowlist {
  if (!isRecord(json) || !isRecord(json['licences']) || !Array.isArray(json['overrides'])) {
    throw new Error('allowlist must have a "licences" object and an "overrides" array');
  }
  const licences: Record<string, string> = {};
  for (const [id, reason] of Object.entries(json['licences'])) {
    if (canonicalId(id) !== id || id.endsWith('+')) {
      throw new Error(
        `allowlist licence "${id}" is not a canonical SPDX identifier; use "${canonicalId(id)}"`,
      );
    }
    if (!nonEmptyString(reason)) throw new Error(`allowlist licence "${id}" needs a reason`);
    licences[id] = reason;
  }
  const overrides = json['overrides'].map((value: unknown, index): Override => {
    if (
      !isRecord(value) ||
      (value['ecosystem'] !== 'npm' && value['ecosystem'] !== 'pypi') ||
      !nonEmptyString(value['name']) ||
      !nonEmptyString(value['version']) ||
      !nonEmptyString(value['licence']) ||
      !nonEmptyString(value['reason'])
    ) {
      throw new Error(`allowlist override ${index + 1} needs ecosystem, name, version, licence and reason`);
    }
    parse(value['licence']);
    return {
      ecosystem: value['ecosystem'],
      name: value['name'],
      version: value['version'],
      licence: value['licence'],
      reason: value['reason'],
    };
  });
  return { licences, overrides };
}

function label(ecosystem: Ecosystem, name: string, version?: string): string {
  return `${ecosystemLabel[ecosystem]} ${name}${version === undefined ? '' : `@${version}`}`;
}

export function check(
  installed: readonly InstalledPackage[],
  direct: readonly DirectDependency[],
  allowlist: Allowlist,
  registered: ReadonlySet<string>,
): Problem[] {
  const problems: Problem[] = [];
  const allowed = new Set(Object.keys(allowlist.licences).map(id => id.toLowerCase()));
  const usedOverrides = new Set<Override>();

  for (const pkg of installed) {
    const override = allowlist.overrides.find(
      o =>
        packageKey(o.ecosystem, o.name) === packageKey(pkg.ecosystem, pkg.name) && o.version === pkg.version,
    );
    if (override) usedOverrides.add(override);
    const licence = override?.licence ?? pkg.licence;
    const source = override ? 'allowlist override' : pkg.source;
    const subject = label(pkg.ecosystem, pkg.name, pkg.version);

    if (licence === undefined) {
      problems.push({
        kind: 'no-licence',
        message: `${subject}: no usable licence declared (${source}). Check its licence by hand and add an override to the allowlist.`,
      });
      continue;
    }
    let expression;
    try {
      expression = parse(licence);
    } catch (error) {
      if (!(error instanceof SpdxError)) throw error;
      problems.push({
        kind: 'no-licence',
        message: `${subject}: "${licence}" (${source}) is not an SPDX expression. Check its licence by hand and add an override to the allowlist.`,
      });
      continue;
    }
    if (!isAllowed(expression, allowed)) {
      problems.push({
        kind: 'not-allowed',
        message: `${subject}: ${licence} (${source}) is not on the AGPL-compatible allowlist.`,
      });
    }
  }

  const seen = new Set<string>();
  for (const dependency of direct) {
    const key = packageKey(dependency.ecosystem, dependency.name);
    if (registered.has(key) || seen.has(key)) continue;
    seen.add(key);
    problems.push({
      kind: 'unregistered',
      message: `${label(dependency.ecosystem, dependency.name)} (declared in ${dependency.declaredIn}): missing from THIRD_PARTY_LICENCES.md. Add a table row naming \`${dependency.name}\` (${ecosystemLabel[dependency.ecosystem]}).`,
    });
  }

  for (const override of allowlist.overrides) {
    if (!usedOverrides.has(override)) {
      problems.push({
        kind: 'unused-override',
        message: `${label(override.ecosystem, override.name, override.version)}: allowlist override matches no installed package. Remove it, or update it after checking the new version.`,
      });
    }
  }

  return problems;
}
