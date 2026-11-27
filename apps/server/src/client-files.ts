// Serves the client's built bundle (P2-14) from the same process and origin as the API and the game
// WebSocket, so sessions need no cross-origin handling once deployed (P2-01).
//
// Vite names everything under /assets/ by its content hash, so those files are cached for a year;
// everything else, index.html and the manifest included, is revalidated on every load. An address with
// no extension that matches no file is one of the client's own pages, such as a game at /abcd1234, and
// gets index.html.

import { readFile, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';

const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const IMMUTABLE = 'public, max-age=31536000, immutable';

export interface ClientFiles {
  /** Answers the request from the bundle, or returns false if the bundle has nothing for it. */
  serve(request: IncomingMessage, response: ServerResponse, pathname: string): Promise<boolean>;
}

export function clientFiles(directory: string): ClientFiles {
  const root = path.resolve(directory);

  async function fileAt(pathname: string): Promise<string | undefined> {
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return undefined;
    }
    if (decoded.includes('\0')) return undefined;
    const candidate = path.resolve(root, `.${decoded}`);
    // Nothing outside the bundle, however the address is spelt.
    if (candidate !== root && !candidate.startsWith(root + path.sep)) return undefined;
    const info = await stat(candidate).catch(() => undefined);
    return info?.isFile() === true ? candidate : undefined;
  }

  return {
    async serve(request, response, pathname) {
      let file = await fileAt(pathname);
      if (file === undefined) {
        if (path.extname(pathname) !== '') return false;
        file = path.join(root, 'index.html');
      }
      const body = await readFile(file).catch(() => undefined);
      if (body === undefined) return false;
      const relative = path.relative(root, file).split(path.sep).join('/');
      response.writeHead(200, {
        'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream',
        'Content-Length': body.length,
        'Cache-Control': relative.startsWith('assets/') ? IMMUTABLE : 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      });
      response.end(request.method === 'HEAD' ? undefined : body);
      return true;
    },
  };
}
