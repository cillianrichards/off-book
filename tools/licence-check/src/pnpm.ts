// How to run pnpm from a child process on every OS.
//
// Spawning `pnpm` by name fails on Windows, where pnpm on PATH is a `.cmd` shim and Node will not run
// one without a shell. When the check runs as `pnpm check-licences`, pnpm records its own location in
// `npm_execpath`, so that is used directly: a JavaScript entry point runs under the current Node, and
// anything else (pnpm's standalone executable) runs as itself. Run outside pnpm, it falls back to
// `pnpm` on PATH.

export interface Invocation {
  command: string;
  args: string[];
}

const javaScript = /\.[cm]?js$/i;

export function pnpmInvocation(
  args: readonly string[],
  execPath: string | undefined,
  nodePath: string,
): Invocation {
  if (execPath === undefined || execPath === '') {
    return { command: 'pnpm', args: [...args] };
  }
  if (javaScript.test(execPath)) {
    return { command: nodePath, args: [execPath, ...args] };
  }
  return { command: execPath, args: [...args] };
}
