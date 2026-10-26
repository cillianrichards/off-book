import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { pnpmInvocation } from './pnpm.ts';

const node = 'C:\\Users\\dev\\AppData\\Local\\fnm_multishells\\1\\node.exe';

describe('pnpmInvocation', () => {
  it('runs a JavaScript entry point under the current Node', () => {
    const entry = 'C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\pnpm\\bin\\pnpm.cjs';
    assert.deepEqual(pnpmInvocation(['-r', 'ls'], entry, node), {
      command: node,
      args: [entry, '-r', 'ls'],
    });
  });

  it('recognises .js and .mjs entry points too, in any case', () => {
    assert.equal(pnpmInvocation([], '/opt/pnpm/bin/pnpm.mjs', node).command, node);
    assert.equal(pnpmInvocation([], '/opt/pnpm/bin/PNPM.JS', node).command, node);
  });

  it("runs pnpm's standalone executable as itself", () => {
    const exe = '/root/.local/share/pnpm/.tools/pnpm/12.15.0/node_modules/@pnpm/exe.linux-x64/pnpm';
    assert.deepEqual(pnpmInvocation(['licenses', 'list'], exe, node), {
      command: exe,
      args: ['licenses', 'list'],
    });
  });

  it('falls back to pnpm on PATH when not run through pnpm', () => {
    assert.deepEqual(pnpmInvocation(['-r', 'ls'], undefined, node), { command: 'pnpm', args: ['-r', 'ls'] });
    assert.deepEqual(pnpmInvocation(['-r', 'ls'], '', node), { command: 'pnpm', args: ['-r', 'ls'] });
  });
});
