// P2-14: the shell builds, is installable as a progressive web app, and renders each page. The
// components are TSX, which Node cannot load, so Vite loads them here as it does for the build.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build, createServer, type ViteDevServer } from 'vite';

import type { Route } from './route.ts';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

interface ManifestIcon {
  readonly src: string;
  readonly sizes: string;
  readonly type: string;
  readonly purpose?: string;
}

interface Manifest {
  readonly name: string;
  readonly short_name: string;
  readonly start_url: string;
  readonly display: string;
  readonly icons: readonly ManifestIcon[];
}

// A PNG's width and height sit in its IHDR chunk, straight after the signature.
function pngSize(bytes: Buffer): [number, number] {
  assert.equal(bytes.subarray(1, 4).toString('latin1'), 'PNG');
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

describe('the built app', () => {
  let outDir: string;

  before(async () => {
    outDir = await mkdtemp(path.join(tmpdir(), 'off-book-client-'));
    await build({ root, logLevel: 'silent', build: { outDir, emptyOutDir: true } });
  });

  after(async () => {
    await rm(outDir, { recursive: true, force: true });
  });

  test('links its manifest and scales to a phone’s width', async () => {
    const html = await readFile(path.join(outDir, 'index.html'), 'utf8');
    assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest"/);
    assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1/);
    assert.match(html, /<script type="module"[^>]* src="\/assets\/[^"]+\.js"/);
  });

  test('has what browsers need to install it', async () => {
    const manifest = JSON.parse(
      await readFile(path.join(outDir, 'manifest.webmanifest'), 'utf8'),
    ) as Manifest;
    assert.equal(manifest.name, 'Off Book');
    assert.ok(manifest.short_name.length <= 12, 'a short name fits under a home-screen icon');
    assert.equal(manifest.start_url, '/');
    assert.equal(manifest.display, 'standalone');
    for (const size of ['192x192', '512x512']) {
      assert.ok(
        manifest.icons.some(icon => icon.sizes === size && icon.purpose !== 'maskable'),
        `an ordinary ${size} icon`,
      );
    }
    assert.ok(
      manifest.icons.some(icon => icon.purpose === 'maskable'),
      'a maskable icon',
    );
    for (const icon of manifest.icons) {
      assert.equal(icon.type, 'image/png');
      const [width, height] = pngSize(await readFile(path.join(outDir, icon.src)));
      assert.equal(`${width}x${height}`, icon.sizes, icon.src);
    }
  });
});

describe('the shell', () => {
  let vite: ViteDevServer;
  let render: (route: Route) => string;

  before(async () => {
    vite = await createServer({ root, logLevel: 'silent', server: { middlewareMode: true, hmr: false } });
    const { App } = (await vite.ssrLoadModule('/src/App.tsx')) as typeof import('./App.tsx');
    render = route => renderToStaticMarkup(createElement(App, { route }));
  });

  after(async () => {
    await vite.close();
  });

  test('renders each page under the same header', () => {
    for (const route of [{ page: 'home' }, { page: 'game', id: 'abcd1234' }, { page: 'notFound' }] as const) {
      const html = render(route);
      assert.match(html, /<header class="shell-header"><a class="brand" href="\/">Off Book<\/a><\/header>/);
    }
    // A game page waits for its WebSocket; the board itself is tested in game/components.test.ts.
    assert.match(render({ page: 'game', id: 'abcd1234' }), /Connecting…/);
    assert.match(render({ page: 'notFound' }), /<h1>Not found<\/h1>/);
  });
});
