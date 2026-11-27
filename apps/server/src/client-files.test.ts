import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import { Bus } from './bus.ts';
import { GameService } from './game/index.ts';
import { silentLog } from './log.ts';
import { type RunningServer, startServer } from './server.ts';
import { MemoryGameStore } from './testing/memory-store.ts';
import { testAuthenticate as authenticate } from './testing/test-auth.ts';
import { realTime } from './time.ts';

describe('the client bundle, served by the server', () => {
  let parent: string;
  let server: RunningServer;
  let base: string;

  before(async () => {
    // The bundle sits beside a file it must never serve.
    parent = await mkdtemp(path.join(tmpdir(), 'off-book-bundle-'));
    const bundle = path.join(parent, 'dist');
    await mkdir(path.join(bundle, 'assets'), { recursive: true });
    await writeFile(path.join(bundle, 'index.html'), '<!doctype html><title>Off Book</title>');
    await writeFile(path.join(bundle, 'assets', 'index-abc123.js'), 'console.log(1);');
    await writeFile(path.join(bundle, 'manifest.webmanifest'), '{"name":"Off Book"}');
    await writeFile(path.join(parent, 'secret.txt'), 'not for you');
    const games = new GameService({
      time: realTime,
      log: silentLog,
      store: new MemoryGameStore(),
      bus: new Bus(silentLog),
    });
    server = await startServer({
      port: 0,
      host: '127.0.0.1',
      games,
      authenticate,
      log: silentLog,
      clientDir: bundle,
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  after(async () => {
    await server.close();
    await rm(parent, { recursive: true, force: true });
  });

  test('serves index.html at the root, revalidated on every load', async () => {
    const response = await fetch(`${base}/`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(response.headers.get('cache-control'), 'no-cache');
    assert.match(await response.text(), /<title>Off Book<\/title>/);
  });

  test('serves the client’s own pages, such as a game, as index.html', async () => {
    for (const page of ['/abcd1234', '/abcd1234/', '/no-such-page']) {
      const response = await fetch(`${base}${page}`);
      assert.equal(response.status, 200, page);
      assert.match(await response.text(), /<title>Off Book<\/title>/, page);
    }
  });

  test('caches hashed assets for a year, and types each file', async () => {
    const script = await fetch(`${base}/assets/index-abc123.js`);
    assert.equal(script.status, 200);
    assert.equal(script.headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.equal(script.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    const manifest = await fetch(`${base}/manifest.webmanifest`);
    assert.equal(manifest.headers.get('content-type'), 'application/manifest+json; charset=utf-8');
    assert.equal(manifest.headers.get('cache-control'), 'no-cache');
  });

  test('answers 404 for a missing file with an extension', async () => {
    assert.equal((await fetch(`${base}/assets/missing.js`)).status, 404);
  });

  test('never serves a file outside the bundle', async () => {
    for (const attempt of [
      '/../secret.txt',
      '/%2e%2e/secret.txt',
      '/assets/%2e%2e%2f%2e%2e%2fsecret.txt',
      '/%00',
    ]) {
      const response = await fetch(`${base}${attempt}`);
      const text = await response.text();
      assert.ok(!text.includes('not for you'), attempt);
    }
  });

  test('never serves a file outside the bundle when the path arrives unnormalised', async () => {
    // fetch tidies `..` away before sending, so this request is written by hand.
    const body = await new Promise<string>((resolve, reject) => {
      const outgoing = request(
        { host: '127.0.0.1', port: server.port, path: '/../secret.txt', method: 'GET' },
        incoming => {
          let text = '';
          incoming.setEncoding('utf8');
          incoming.on('data', (chunk: string) => (text += chunk));
          incoming.on('end', () => resolve(text));
        },
      );
      outgoing.on('error', reject);
      outgoing.end();
    });
    assert.ok(!body.includes('not for you'));
  });

  test('leaves the API’s addresses to the API', async () => {
    const response = await fetch(`${base}/api/nothing`);
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal((await fetch(`${base}/health`)).status, 200);
  });
});
