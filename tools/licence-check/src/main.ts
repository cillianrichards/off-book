// Licence check for CI: `pnpm check-licences` from the repository root.
// Needs `pnpm install` and the pipeline's uv environment; exits non-zero on any problem.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { check, loadAllowlist } from './check.ts';
import {
  type Manifest,
  npmDirect,
  npmInstalled,
  type PnpmLicences,
  pythonDirect,
  pythonInstalled,
  type PythonInventory,
} from './inventory.ts';
import { pnpmInvocation } from './pnpm.ts';
import { registeredPackages } from './register.ts';

const root = path.resolve(import.meta.dirname, '../../..');
const allowlistPath = 'tools/licence-check/allowlist.json';
const registerPath = 'THIRD_PARTY_LICENCES.md';

function run(command: string, args: readonly string[]): string {
  return execFileSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

function pnpm(args: readonly string[]): string {
  const { command, args: fullArgs } = pnpmInvocation(args, process.env['npm_execpath'], process.execPath);
  return run(command, fullArgs);
}

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`could not read ${what} as JSON:\n${text.slice(0, 500)}`);
  }
}

function readJson(relative: string): unknown {
  return parseJson(readFileSync(path.join(root, relative), 'utf8'), relative);
}

const allowlist = loadAllowlist(readJson(allowlistPath));
const registered = registeredPackages(readFileSync(path.join(root, registerPath), 'utf8'));

const projects = parseJson(pnpm(['-r', 'ls', '--json', '--depth', '-1']), 'pnpm ls') as {
  path: string;
}[];
const npmDeclared = projects.flatMap(project => {
  const manifest = path.relative(root, path.join(project.path, 'package.json'));
  return npmDirect(readJson(manifest) as Manifest, manifest);
});
const npmPackages = npmInstalled(
  parseJson(pnpm(['-r', 'licenses', 'list', '--json']), 'pnpm licenses') as PnpmLicences,
);

const python = parseJson(
  run('uv', [
    'run',
    '--directory',
    path.join(root, 'pipeline'),
    '--locked',
    '--quiet',
    'python',
    '-I',
    path.join(import.meta.dirname, 'python_inventory.py'),
    path.join(root, 'pipeline', 'pyproject.toml'),
  ]),
  'python_inventory.py',
) as PythonInventory;
const pythonDeclared = pythonDirect(python, 'pipeline/pyproject.toml');
const pythonPackages = pythonInstalled(python);

const problems = check(
  [...npmPackages, ...pythonPackages],
  [...npmDeclared, ...pythonDeclared],
  allowlist,
  registered,
);

const npmDirectCount = new Set(npmDeclared.map(d => d.name)).size;
console.log(
  `Licence check: ${npmPackages.length} npm and ${pythonPackages.length} PyPI packages installed; ` +
    `${npmDirectCount} npm and ${pythonDeclared.length} PyPI direct dependencies.`,
);
if (problems.length === 0) {
  console.log(`Every licence is on the allowlist and every direct dependency is in ${registerPath}.`);
} else {
  const inActions = process.env['GITHUB_ACTIONS'] === 'true';
  console.log(`Licence check failed with ${problems.length} problem${problems.length === 1 ? '' : 's'}:`);
  for (const { message } of problems) {
    console.log(
      inActions ? `::error title=Licence check::${message.replaceAll('%', '%25')}` : `  - ${message}`,
    );
  }
  console.log(`Allowlist: ${allowlistPath}. Register: ${registerPath}.`);
  process.exitCode = 1;
}
